# Browser agents — open a browser, test the UI, screenshot the proof

An agent that builds a feature should be able to *run it* — open the app in a
real browser, click around, and screenshot what it built — and attach that
screenshot to its Change as evidence. ClawHub gives a standing agent those
**hands** (a headless Chromium + a screenshot→evidence pipeline) while
guaranteeing that **whatever the agent does on the network physically stays in
its sandbox**: if something goes wrong, it can't harm anything but the
environment it runs in. The agent can still get its issue and push its code.

ClawHub still **never runs the model**. The model (in your container, with your
key) decides *what* to click and *where* to look; ClawHub provides the browser,
the egress boundary, the screenshot store, and the push token.

---

## The end-to-end flow

A standing agent, on one tick, can:

1. **grab an assigned issue** — `GET /issues?assigned=me&status=open`
2. **implement it** — edit files in the cloned repo at `/workspace`
3. **test the UI in a real browser** — start the app inside the sandbox, drive
   Chromium against `http://localhost:<port>`, assert what it expects
4. **screenshot what it built**
5. **open a Change** — push to `refs/for/<branch>` (normal merge governance)
6. **attach the screenshot to the Change** as review evidence

This is verified end-to-end by `scripts/verify-browser-agent.sh`, which runs a
deterministic, LLM-free demo agent (`packages/agent-harness/demo`) through the
real runner + egress sandbox and asserts every step against the API.

---

## Network containment — "stays in the environment"

The runner runs a standing-agent container with network (it has to reach an LLM,
and now a browser). Containment is enforced so that network access can't become a
way to harm anything outside the sandbox.

### Egress policy (per agent)

`standing_agents.egressPolicy` + `egressAllowedHosts`:

| Policy | The container can reach |
|--------|--------------------------|
| `none` (default) | **Infra only**: ClawHub (API + git) and the LLM endpoint. The browser still hits the app the agent starts on `localhost`. Nothing else on the internet. |
| `allowlist` | Infra **+** the host patterns you list (`example.com`, `*.staging.test`, `.internal.dev`, or a literal IP). |
| `all` | Any **public** host. |

In **every** mode — including `all` — these are **always blocked**: loopback,
RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local + **cloud metadata**
(`169.254.0.0/16`, incl. `169.254.169.254`), CGNAT (`100.64/10`), unique-local
IPv6, multicast. "Open to the internet" never means "open to the Postgres on the
same box" or "open to the cloud metadata endpoint". This is the
SSRF / lateral-movement guard.

The guard decides on the **canonical address, not its spelling**. Every IPv6 form
that embeds an IPv4 address — v4-mapped (`::ffff:7f00:1`, which is what WHATWG
`URL` serializes `::ffff:127.0.0.1` into), v4-translated, v4-compatible, 6to4
(`2002::/16`) — is resolved to the embedded v4 and run through the same v4 range
table, and IPv6 itself is decided as an **allowlist of what is public**: only
global unicast `2000::/3` is reachable, so NAT64, discard, documentation and any
future special-purpose range fail closed rather than defaulting to "public".

### How it's enforced

The runner, per run:

1. creates an **`--internal` Docker network** (no NAT/route to the internet of
   its own) and puts the agent container on it — so the agent has **no direct
   path off-box**;
2. starts a dual-homed **egress proxy** container (`packages/runner/egress-proxy.cjs`)
   — on the internal network (the agent reaches it) **and** a normal bridge (it
   reaches the internet) — and points the agent's `HTTP(S)_PROXY` at it;
3. the proxy **allow/deny-decides every connection** by host + resolved IP,
   pins the resolved IP (anti DNS-rebind), and **logs every decision into the run
   record**;
4. tears the network + proxy down after the run.

If the agent ignores the proxy and opens a raw socket, the internal network has
no route and the connection **fails closed**.

Hosts that are reachable regardless of policy come in **two tiers**, because only
one of them may skip the guard above (`packages/runner/infra-hosts.cjs`):

| Tier | Derived from | Reachable under any policy | Skips the private-IP guard |
|------|--------------|----------------------------|----------------------------|
| **Infra** (`EGRESS_INFRA`) | the runner's OWN config: `CLAWHUB_URL`, the `CLAWHUB_RUNNER_INFRA_HOSTS` escape hatch, and — for a **standing** run only — the `CLAWHUB_URL` the API itself authored | yes | **yes** — a single-box self-host serves its API from a private IP |
| **Soft infra** (`EGRESS_SOFT_INFRA`) | the run's secrets bag (any `*_BASE_URL`, and `CLAWHUB_URL` on a pipeline run) + the well-known LLM provider domains | yes | no |

Secret *names* are tenant-controlled, so anything derived from the secrets bag is
soft: a BYO agent's custom gateway keeps working under `egress: none`, but setting
`X_BASE_URL=http://169.254.169.254` does not buy an exemption from the guard. The
one exception is a **standing** run, whose whole env is built by the API
(`standingRunEnv`) rather than by `decryptRepoSecrets` — there `CLAWHUB_URL` is the
operator's `CLAWHUB_PUBLIC_URL`, so it keeps the exemption a private-address
self-host needs. An operator who needs any other private infra host sets
`CLAWHUB_RUNNER_INFRA_HOSTS` on the runner — the same trust boundary as the API URL.

`localhost` (the app under test, inside the same container) bypasses the proxy
entirely, so UI testing needs no network at all.

> Escape hatch: `CLAWHUB_RUNNER_NO_EGRESS_PROXY=1` reverts to the legacy open
> `--network bridge` for trusted single-tenant runners. Not recommended.

> Operator knob: `CLAWHUB_RUNNER_EXTRA_HOSTS=name:addr,...` adds `--add-host`
> mappings to the sandbox containers (e.g. `host.docker.internal:host-gateway`
> so a contained agent can reach a ClawHub API on the runner host in dev).

---

## Browser hands (the reference harness)

`packages/agent-harness` is built on the official Playwright image, so Chromium +
its system libraries are baked in. It exposes two commands:

### `clawhub-browse` — drive the browser

```bash
clawhub-browse --url http://localhost:3000 --out shot.png
echo '[{"goto":"http://localhost:3000"},{"waitFor":"#save"},{"click":"#save"},
      {"expectText":"Saved"},{"screenshot":"after-save.png"}]' | clawhub-browse
```

Steps: `goto`, `click`, `fill`/`type`, `press`, `waitFor`/`waitForTimeout`,
`screenshot` (`fullPage` default true), `expectText` (assertion). Screenshots land
in `/workspace/.clawhub-evidence`; a JSON result (`{ok, finalUrl, screenshots,
steps, consoleErrors}`) is printed and written to `browse-result.json`. Chromium
honors the egress proxy via `HTTPS_PROXY`; loopback is excluded
(`--proxy-bypass-list <-loopback>`), so the in-sandbox app is reached directly.

### `clawhub-evidence` — upload + attach a screenshot

```bash
clawhub-evidence <changeId> /workspace/.clawhub-evidence/after-save.png "After save" "Verified the save flow renders the confirmation."
```

Uploads the PNG to the Change's evidence store, then submits a `comment` review
carrying the URL as `evidence[{kind:"screenshot", url}]`. (An agent can't *approve*
its own Change, but it can comment with evidence — "here's what I built, here's
the proof.")

The reference worker entrypoint (`entrypoint.sh`) also runs this automatically
when given `CLAWHUB_VERIFY_URL` / `CLAWHUB_VERIFY_STEPS` (+ optional
`CLAWHUB_VERIFY_SERVE` to start the app).

---

## Evidence storage

`routes/change-evidence.ts`:

- `POST /api/v1/repos/:ns/:repo/changes/:id/evidence` — raw image/log body
  (≤16MB), review-level auth (writer/reviewer agent or human). Stores
  object-store-backed (`CLAWHUB_EVIDENCE_PATH`, or S3 when
  `CLAWHUB_OBJECT_STORE=s3`) and returns `{url, blobId, contentType, size}`.
- `GET /api/v1/repos/:ns/:repo/changes/:id/evidence/:blobId` — read-authorized
  (a private repo's screenshots stay private), returns the bytes.

The dashboard `EvidencePanel` fetches the blob with the caller's token
(`AuthedImg`) and renders it inline under the review.

---

## Configuring it

- **Dashboard**: repo Settings → Standing agents → *Network access (egress)*.
- **CLI**: `ch standing add … --egress allowlist --egress-host example.com --egress-host '*.staging.test'`
- **API**: `egressPolicy` + `egressAllowedHosts[]` on
  `POST/PATCH /api/v1/repos/:ns/:repo/standing-agents`.

Point the agent at the Playwright-based reference image
(`packages/agent-harness`, build: `docker build -t clawhub-agent-harness
packages/agent-harness`) or your own image that honors `HTTP(S)_PROXY` and bakes
in a browser.

---

## Two browser-driven modes: `develop` and `verify`

The same browser hands serve two roles. Both pre-authenticate (seed a throwaway
user via `clawhub-login`, inject its token into `localStorage` so the browser
lands logged in, never on `/login`) and both run egress-contained.

### `develop` — the autonomous UI dev loop

A `develop`-mode standing agent (`mode:'develop'`, the **`developer`** Role
template) builds a UI feature end-to-end *without a human*:

1. **Goal in, two ways** — set the agent's task (a prompt) **or** assign it an
   issue. With a task it builds that; with no task it grabs an assigned issue
   (`GET /issues?assigned=me`). That is the whole human-input surface.
2. **App kept warm** — `run_develop` boots the app from `.clawhub/verify.yml`
   `serve` once and leaves it running, so hot-reload makes the edit→see loop
   tight.
3. **Iterate against the real UI** — edit code → the dev server reloads → open
   the changed route, **look at** the rendered UI and **click** through it →
   judge layout/states/interactions against the goal → fix → repeat.
4. **Ship with proof** — opens one Change and attaches the finished screenshot.

Deploy: `ch role developer --repo <ns/repo> --cli claude` (grabs issues), or add
`--task "build the X panel"` for a one-off. Under the hood it is a standing agent
with `mode=develop`, so `ch standing add --mode develop --task …` works too.

### `verify` — the reviewer that exercises the change

A `verify`-mode reviewer (the **`verified-reviewer`** Role) reviews **both the
code and the behavior**: it reads the diff, then drives the *specific changed
surface* in the browser, screenshots it, and reports a server-trusted
attestation. The screenshot it attaches is the **changed surface**, not a generic
baseline — see *Evidence selection* below.

## Native interactive browser (MCP) — opt-in

By default both modes drive the UI with `clawhub-browse` (a batch Playwright
script) and the model **Reads the resulting PNG** to look at it. That reuses the
base image's Chromium and needs no extra infra.

Set **`CLAWHUB_BROWSER_MCP=1`** (claude only) to instead give the model the
official Playwright **MCP** browser — a live, stateful browser exposed as real
tools (`browser_navigate`/`browser_click`/`browser_snapshot`/
`browser_take_screenshot`), whose accessibility snapshot **and** screenshot the
model sees after *every* action (a true perceive→act→perceive loop). The harness
wires it via `--mcp-config` + `clawhub-browser-mcp` (a wrapper that runs
`playwright-mcp` headless, routes through `HTTPS_PROXY`, bypasses loopback, and
pre-seeds the auth session via `--storage-state`). It is opt-in because
`@playwright/mcp` pins a newer Chromium than the base image; the build bakes it
best-effort and the harness falls back to `clawhub-browse + Read` if it is absent.

## Evidence selection (which screenshot gets attached)

`attach_evidence` (used by develop, verify, and worker) attaches the
**changed-surface** screenshot, preferring a model-named
`/workspace/.clawhub-evidence/changed-<route>.png`, then the newest non-error
shot. This replaces an earlier `ls | head -1` that grabbed the *first* PNG — which
was usually the generic baseline (`/feed`) or an `error-step-*.png`, so a Change's
evidence rarely showed the surface the diff actually changed. The mode prompts and
`.clawhub/verify.yml` plan now instruct the agent to save the changed surface as
`changed-<route>.png`.
