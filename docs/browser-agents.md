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
no route and the connection **fails closed**. Infra hosts (ClawHub + the LLM) are
always allowed even if they resolve to a private address (a single-box self-host
serves its API from a private IP) — these are operator-trusted.

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
