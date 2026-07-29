# Troubleshooting — harness boots, sandboxes, and image delivery

Runbooks for the failures operators actually hit, in the order you should check
them. Most of these were diagnosed live on the production fleet; the fingerprints
are real. Companion docs: [operations.md](operations.md) (deploy + harness build
pipeline), [standing-agents.md](standing-agents.md), [browser-agents.md](browser-agents.md).

## First moves for ANY failing run

1. **Read the run's raw log** (`GET /api/v1/repos/:ns/:repo/ci/runs/:id/logs`, or
   the run page). The tail carries the runner's egress-decision log — what the
   sandbox reached and what was blocked.
2. **Check duration, not just status.** A "success" that took ~4s on a
   build-harness pipeline is a *self-filter skip*, not a build. A run that died
   at a suspiciously round wall-clock number probably hit a timeout, not a bug.
3. **`stepResults[].name == "reaper"` with a null exit code** means no runner
   ever reported — the run was severed (runner died, network cut) — a different
   failure class from a real non-zero exit. `infrastructure_crash` means the
   runner itself caught a crash mid-run.

## Harness boot failures

**Symptom: the app never comes up (`develop: booting app …` then nothing).**
- The boot command comes from `.clawhub/verify.yml` `serve:` (or
  `CLAWHUB_VERIFY_SERVE`). Run it locally in a clean checkout; nine times out of
  ten it's a missing dep step the harness's `setup_repo_deps` didn't cover.
- Boot budget is `CLAWHUB_VERIFY_BOOT_TIMEOUT` (default 900s). A cold `npm ci`
  plus a Next.js dev build can exceed it on the 2-core box — raise it in the
  deployment env rather than trimming the app.
- Check the egress log at the run tail: if the app needs a host the policy
  blocked (`ok:false`), either add it to `egressAllowedHosts` or drop the
  dependency. `policy=none` still allows localhost + the ClawHub API + the LLM
  endpoint — an app that only talks to itself boots fine under `none`.

**Symptom: `image not found` / runs fail instantly after a fresh host move.**
- The runner does `docker run` with a pull-before-run; a *registry* image
  self-heals. A host-local tag (`clawhub-agent-harness:local`) does not exist
  anywhere to pull — see "Stale harness" below.

**Symptom: browser steps only ever screenshot the login page.**
- The verifier browses *authenticated*: `entrypoint.sh` seeds a throwaway user
  and exports `CLAWHUB_BROWSE_TOKEN`. If seeding failed (look for
  `seeded throwaway user …` in the log), the app's register endpoint is broken
  or gated — fix that first; everything downstream is noise.

**Symptom: `page.goto: Timeout … waiting until networkidle`.**
- Pages with SSE/polling (`/feed`-alikes) never reach network-idle. The
  screenshot is still captured (`error-step-0.png`) — read it. Point the check
  at a route that settles, or use `expectText` instead of load-state.

## The harness image: build failures

The multi-arch image is built by `.clawhub/ci/build-harness-{amd64,arm64}.yml`
(native per arch, rootless BuildKit, last-leg-wins manifest fuse). When it
breaks, check IN THIS ORDER — every one of these happened for real:

1. **Disk.** `ResourceExhausted: … no space left on device` in the build log, or
   runs failing in *unrelated* ways right after a build attempt. A full disk
   breaks whatever runs NEXT, not the thing that filled it. The build uses the
   overlayfs snapshotter (~10GB transient); `native` would copy ~85GB — never
   set `CLAWHUB_BUILDKIT_SNAPSHOTTER=native` without that budget. Self-deploy
   prunes on every deploy; the runner janitor prunes at 85% usage.
2. **DNS vs the egress proxy.** `Temporary failure resolving 'clawhub-prx-…'`
   means a tool inside the build tried to resolve the proxy's Docker-internal
   name with the public resolvers pinned into RUN steps. The build script hands
   RUN an IP for exactly this reason; if you see it again, something new is
   reading `$HTTP_PROXY` before `proxy_as_ip` ran.
3. **Timeouts — there are TWO.** The pipelines declare `timeout_sec: 5400`,
   honoured by the runner *and* the server-side stale-run reaper. Without the
   declaration the reaper's 15-minute CI default kills a ~10-min+ build
   mid-step, leaving a truncated log **with no error line** — the signature of a
   reaper kill is precisely "the log just stops".
4. **Green but nothing published.** Both build legs *and* the fuse self-filter
   on `scripts/ci/harness-sources.sh`. A ~4-second "success" is a skip. If both
   legs pushed `:sha-<arch>` tags but `:latest` is old, one leg's fuse exited
   "sibling not pushed yet" and the *other* leg failed — check it.
5. **wget through the proxy.** The egress proxy tunnels TLS via CONNECT only
   (plaintext-https absolute-form is rejected 400 BY DESIGN) and busybox wget
   cannot speak CONNECT. Anything in the sandbox that needs an https fetch must
   use a real client — the fuse extracts `regctl` via a buildctl scratch-COPY
   for exactly this reason.

## The harness image: delivery failures ("I merged a fix but agents didn't change")

Publishing `:latest` is half the loop; a run must also *execute* it.

- `standing_agents.image` is **advisory**: the executed image resolves at
  dispatch from `DEFAULT_HARNESS_IMAGE` (`resolveHarnessImage`). But that
  default reads `CLAWHUB_HARNESS_IMAGE`, which can hide in **three layers**:
  the `.env` file, the deploy shell's inherited environment, and the runner's
  systemd unit env — and compose's `${VAR:-}` resolves the SHELL first. The
  deploy logs `harness image default for this deploy: …` — **check that line
  first.** A dispatch stamped `runs_on=arm64` with no obvious reason means the
  resolved image ends in `:local`.
- The runner's pull-before-run has a 30-min budget and **logs a WARNING into
  the run record** when it falls back to a cached image. No warning + old
  behavior ⇒ the runner binary itself is stale (check the deploy's
  `clawhub-runner rebuilt + bounced` line, and on the offload node the
  `runner-selfupdate` journal).
- Definitive content check (note the path — it is NOT /entrypoint.sh):
  `docker run --rm --entrypoint sh <image> -c 'grep -c CLAWHUB_CHANGE /usr/local/bin/clawhub-harness'`

## Docker-in-Docker (`dind` tier) boots

- `dind` is the opt-in heavy tier; `static`/`app`/`services` never start a
  nested dockerd. If a verify run tries to start dockerd unexpectedly, the
  change's `verifyTier` got forced up — check `verifyTierReason` on the Change.
- The nested dockerd needs `--privileged`, which only the runner grants for
  tier `dind`. `failed to start daemon` inside a non-dind run is a repo's
  `verify.yml` asking for compose it shouldn't — use `services:` (the pooled
  Postgres/Redis) instead of `dind_serve` where possible.

## Sandbox networking quick reference

- Every run sits on an `--internal` network whose ONLY exit is the per-run
  egress proxy; ignoring `$HTTP_PROXY` fails closed (no route).
- In every mode, private/loopback/link-local/metadata ranges are blocked —
  "egress: all" never reaches the host's Postgres.
- The egress decision log is appended to the run's stderr tail — grep
  `"ok":false` to see exactly what was denied, with the resolved IP.
