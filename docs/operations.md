# Operations — how this instance deploys itself

This documents the **production instance at useclawhub.com**, which hosts this
repository as `xinmingzhang/clawhub` — a user-owned namespace; the `claude-code`
agent is a granted writer that pushes the deploys — and deploys itself when
Changes merge.
For deploying a *new* instance from scratch, see [self-host.md](self-host.md).
For pipeline/runner concepts, see [ci.md](ci.md).

## Topology

- **Host**: an OCI Always-Free A1 instance (`clawhub-prod`, 167.234.210.125,
  2 OCPU / 12 GB — the free ceiling), Ubuntu, admin over SSH (key-only,
  restricted to admin IPs). The public path is Cloudflare (proxied DNS, SSL
  mode "Full", rate limiting) → origin Caddy. The OCI Security List allows
  80/443 **only from Cloudflare's IP ranges** and 22 only from admin IPs, so
  the origin can't be hit directly (no WAF/rate-limit bypass via a spoofed
  Host header). Infra automation + the firewall/watchdog/decommission runbook:
  [`deploy/oci/README.md`](../deploy/oci/README.md). **The web + data plane is
  OCI-only.** *(Prod ran on a home Debian box (`debian-server`) behind a router
  until the 2026-06 OCI migration; the WEB host moved fully to OCI. `debian-server`
  serves no traffic and is not a web standby — but it is NOT gone: it was repurposed
  as a second **CI/verify/standing-agent runner** (amd64, 12c/15GB, behind Tailscale)
  that offloads runs from OCI. So the runner tier is TWO-arch — OCI arm64 + debian
  amd64 — which is why the agent-harness image must be published multi-arch.)*
- **Latency note**: the origin is in OCI us-sanjose-1. User-perceived latency
  is the Cloudflare-edge↔origin round trip, not the app (origin TTFB ≈3ms).
  To cut it: enable Cloudflare **Argo Smart Routing** + **Tiered Cache**, add
  **Cache Rules** for the anonymous HTML + the `s-maxage`-tagged public API
  GETs (`/api/v1/public/*`), and turn on **HTTP/3** — all in the Cloudflare
  dashboard. The origin already gzips `/api/*` before the hop. The only way to
  remove the ~70ms speed-of-light floor on *dynamic* requests is to move/clone
  the origin region closer to users.
- **Stack**: `docker compose --profile proxy` in `~/clawhub` — api, dashboard,
  caddy, postgres, redis. Postgres/Redis have no host ports; api/dashboard
  bind loopback only; Caddy is the only public listener.
- **`~/clawhub` is a git checkout** of `xinmingzhang/clawhub` with `origin`
  pointing at the local API (`http://agent-token:…@localhost:3000/xinmingzhang/clawhub.git`)
  and a `github` remote (mirror at `maxz712/clawhub`, SSH deploy key).
- **CI runner**: systemd unit `clawhub-runner` runs
  `packages/runner/dist/index.js` as the admin user (docker access). It
  subscribes to `ci.run.queued` over SSE and reconnects forever — including
  through API restarts caused by its own deploys.

## How code ships (merge = deploy)

1. Push a branch with trailers → a Change opens.
2. The `tests` pipeline (`on: push`) runs `npm ci`, builds the API, runs the
   test suite. Its result is the Change's `ciStatus`; the repo's merge policy
   sets `ciRequired: true`, so red CI blocks merging.
3. One approval from a reviewer other than the opener (agent or human).
4. Merge (dashboard button or `POST …/changes/:id/merge`). The `deploy`
   pipeline (`on: merge`) runs [`scripts/self-deploy.sh`](../scripts/self-deploy.sh)
   at the merge commit: reset `~/clawhub` to it, `docker compose build` with
   `GIT_SHA` stamped, `up -d`, health-check, rebuild+bounce the runner, mirror
   `master` to GitHub, and — **only if the merge changed `packages/agent-harness/**`**
   — auto-rebuild + republish the agent-harness image (see below).
5. Verify: `curl https://api.useclawhub.com/api/v1/health` — `version` must
   equal the merge commit SHA.

### Agent-harness image auto-build

The harness image (`ghcr.io/maxz712/clawhub-agent-harness:latest`) bakes in
`verify`/`develop` mode + the four CLIs + Playwright/Chromium; deployed
reviewers/developers run it. It has TWO consumers — the OCI arm64 runner and the
debian amd64 runner — so it must be published **multi-arch**.

**Primary: the build-harness CI matrix.** Two `on: event` / `change.merged`
pipelines — `.clawhub/ci/build-harness-{amd64,arm64}.yml` — build each arch
**natively on its matching runner** (via `runs_on: <arch>`, so no QEMU). Each pushes
a per-arch tag `:<sha>-<arch>` (`scripts/ci/build-harness-arch.sh`); the amd64
pipeline's 2nd step (`scripts/ci/assemble-harness-manifest.sh`) waits for both tags
then fuses them into multi-arch `:latest` (+ `:<sha>`). The scripts self-filter to
`packages/agent-harness/**` changes (no native path filter), so unrelated merges are
a fast no-op. The manifest step **hard-fails** if either arch is missing — `:latest`
never points at a half-built single-arch image. Runners pick up the new image via a
**pull-before-run** in the runner (`docker pull` before each `docker run`), so a
republished `:latest` takes effect on the next run without any host-cache coordination.

Two platform pieces make this work: `runs_on` arch-targeted dispatch (parsed in
`ci-yaml.ts`, threaded through `ci-trigger.ts`, matched against `process.arch` in the
runner — fail-safe: no `runs_on` ⇒ any runner claims); and `mergeLocked` now writing
`branches.headCommit` on merge, so `on: event`/`on: schedule` runs resolve the *merge*
commit instead of a stale trunk head (this was a latent bug affecting all such pipelines).

**Fallback: self-deploy inline build.** `self-deploy.sh` keeps an always-on
**presence-pull** (bootstraps a host that never had the image) and a **break-glass**
inline multi-arch build (QEMU on the arm64 host — slow) gated behind
`CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1` (default off), for when the CI matrix is
broken/backlogged. It runs after the deploy lock releases and never aborts a deploy.

**One-time setup.** (1) Register the two pipelines — this repo advances master by
merge, and `.clawhub/ci` auto-syncs only on default-branch *pushes*, so register them
by hand once (they become DB rows): `ch ci put xinmingzhang/clawhub build-harness-arm64
.clawhub/ci/build-harness-arm64.yml` and likewise `build-harness-amd64`. (2) Repo CI
**secrets** `GHCR_USER` + `GHCR_TOKEN` (a `write:packages` PAT) via `ch secrets` /
dashboard Settings → Secrets — both runners fetch them per-run to `docker login ghcr.io`.
(3) Make the `clawhub-agent-harness` ghcr package **public** on first publish (else the
runner pull fails). (4) Both runner agents stay in `CLAWHUB_RUNNER_AGENT_IDS` (they
already run other CI) — `runs_on` does the arch routing without removing them. For the
break-glass fallback only: QEMU binfmt on the OCI host (`docker run --privileged --rm
tonistiigi/binfmt --install all`) + a host `docker login`. **Verify** after a
harness-touching merge: `docker manifest inspect
ghcr.io/maxz712/clawhub-agent-harness:latest` lists both arches, and a verify run
landing on the amd64 runner does not fail `exec format error`.

**The `deploy` pipeline MUST be `triggerKind: merge`, never `push`.** It was
once stored as `push` (the YAML said `on: merge` but the DB `triggerKind`
hadn't been re-derived), which meant *every* branch push — including unmerged
feature branches — ran `self-deploy.sh` and shipped un-reviewed code straight
to prod, bypassing the merge gate. The merge hook (`services/changes.ts`,
"on: merge … deploy hook") only enqueues pipelines whose `triggerKind=merge`.
Check with `GET …/ci/pipelines` (deploy → `merge`); re-derive by re-`PUT`ting
the pipeline yaml. (Pipelines here are DB rows, not `.clawhub/ci/` files —
follow-up: version-control them so the trigger can't silently drift.)

Pipelines are stored per-repo in the database, not in this tree. View or edit:
`GET/PUT /api/v1/repos/xinmingzhang/clawhub/ci/pipelines/:name` (or `ch ci`).

**Bootstrap exception**: pushes to `master` bypass the Change flow by design
(default-branch pushes don't open Changes). Reserve direct pushes for fixes
the pipeline itself depends on — e.g. CI is broken and no Change can pass.

## Capability-graded CI execution

CI pipeline steps run one of two ways, decided **server-side** and stamped into the
`ci.run.queued` payload (the runner obeys the stamp, never the YAML):

- **sandbox (default)** — steps run in a per-run **container** (fresh `--rm`, `--internal`
  network + fail-closed egress proxy, `--cap-drop=ALL`, resource-limited, a **server-pinned
  image**, and **only** the per-run secrets — never the runner's `process.env`/token). An
  untrusted repo's CI therefore cannot reach the host, docker, sibling runs, or the runner's
  token: **it cannot kill prod.** `services/ci-host-exec.ts` + `packages/runner` (`isHostExec`).
- **deploy** — the runner runs ONLY the fixed, reviewed entrypoint `scripts/self-deploy.sh`
  on the host, **never the pipeline's YAML steps** — so the deploy is a *capability of the CI
  system*, not "arbitrary host shell in a pipeline" (a deploy pipeline can't inject commands).
  This is the one irreducible host act (restart the box's own stack) done by trusted infra
  (the runner). The deploy pipeline is just `on: merge` + `execution: deploy` — no steps.
- **build** — the pipeline's steps run in a CONTAINED rootless-BuildKit sandbox: build+push
  images with **no host docker**. Still contained (`--internal` net + egress proxy, no host
  mount/socket, secrets-only env) — just with the seccomp/apparmor relaxation user-namespaced
  rootless build needs, which is exactly why it is allowlisted-only. The harness-build matrix
  (`.clawhub/ci/build-harness-*.yml`) uses this (`buildctl` per arch, `regctl` for the manifest).
- **host** — the pipeline's YAML steps run on the host with full env (general host shell).
  **No pipeline uses this anymore** — it's retained as a defined capability/escape hatch but is
  not wired to anything. All three privileged modes are granted ONLY when the repo is in
  `CLAWHUB_CI_HOST_EXEC_REPOS` **and** its pipeline requests them; a tenant requesting any on
  their own repo resolves to sandbox (operator-only, un-self-grantable). Resolved server-side,
  stamped in the payload; the runner obeys the stamp, never the YAML.

So the dogfooding end-state holds: the only host power left is the fixed `deploy` apply
(restart the box's own stack — irreducible), and every build runs contained like any tenant's
CI. **The one live-host go/no-go** for the contained build: `unshare -Ur echo ok` (user
namespaces enabled) + confirming the harness build (Playwright+Chromium+CLIs) starts rootless
BuildKit and fits in 12GB on this box. If it can't, flip that repo's build pipelines back to
`execution: host` (still allowlisted) or use the self-deploy inline break-glass
(`CLAWHUB_SELFDEPLOY_BUILD_HARNESS=1`) while tuning — nothing is stranded.

**One-time operator setup** for this prod (required so the deploy/build keep host access —
skip it and those pipelines sandbox themselves and fail):
1. Set `CLAWHUB_CI_HOST_EXEC_REPOS=xinmingzhang/clawhub` in the API env (add the harness
   repo if separate). Empty ⇒ *no* repo gets host (fail closed).
2. The **deploy** pipeline is a DB row — re-`PUT` its YAML as just `on: merge` + a top-level
   `execution: deploy` (drop its `steps:` — the runner runs the fixed `scripts/self-deploy.sh`,
   not the YAML). The **build-harness** pipelines declare `execution: host` in
   `.clawhub/ci/build-harness-*.yml` (until contained rootless builds land).
3. **Deploy the API before the runner** (self-deploy already does this — it rebuilds+restarts
   api/dashboard, *then* rebuilds+bounces the runner), so the new runner's fail-closed
   "absent ⇒ sandbox" default never bricks an in-flight deploy: by the time the new runner is
   live, the new API is already stamping `execution: host` for the allowlisted repo.

Multi-tenant follow-ups (not needed for single-tenant self-host): pin host-exec repos to a
dedicated runner pool via `CLAWHUB_RUNNER_AGENT_IDS` and refuse dispatch to runners below a
min version (closes the un-upgraded-runner bypass); a server-validated per-repo image override
for sandbox CI; per-step reporting in sandbox mode.

## Where things live on the host

| Path | What |
|---|---|
| `~/clawhub` | the deployed checkout (resets to each merge commit) |
| `~/clawhub/.env` | all secrets: JWT, Postgres/Redis passwords, OAuth, sealing key. **Untracked — survives resets. Never overwrite via file transfer.** |
| `~/.clawhub-env.backup` | canonical copy of `.env`, outside the checkout |
| `~/clawhub-credentials.txt` | agent tokens + claim tokens (mode 600) |
| `~/.clawhub-runner.env` | runner's `CLAWHUB_URL` + agent token (re-read on service restart) |
| `~/.docker/config.json` | **ghcr push credential** for the auto harness-image build (`docker login ghcr.io -u maxz712` with a `write:packages` PAT). Host-local, does NOT travel on a host move — like the SSH deploy key. Without it, a harness-changing deploy logs a loud warning and the registry image goes stale. |
| `~/.cloudflare-ddns.env` + `~/bin/cloudflare-ddns.py` | DDNS updater (cron, every 5 min) |
| `~/backups/` | nightly 3am DB dump + repos tarball, 14-day retention |
| `/etc/systemd/system/clawhub-runner.service` | runner unit |
| `/etc/systemd/system/cf-ingress.{service,timer}` + `/usr/local/sbin/cf-ingress.sh` | restricts ports 80/443 to Cloudflare + LAN; refreshes ranges weekly |

## Runbooks

**Site down / API unhealthy**
```bash
cd ~/clawhub && docker compose ps         # what's not Up?
docker logs clawhub-api-1 --tail 50
docker compose --profile proxy up -d      # start anything stopped
```
If a deploy was interrupted mid-recreate (orphaned `…_clawhub-api-1` in
"Created"), remove the conflict and bring it up:
`docker rm -f <orphan> clawhub-api-1 && docker compose --profile proxy up -d`.

**Roll back a bad merge**
Revert through the same flow: branch from the last good commit,
`git revert <merge-sha> -m 1`, push, review, merge — the deploy pipeline
ships the revert. (Direct-push to master only if the bad merge broke CI
itself.)

**Deploy run stuck at "running"**
The runner retries terminal reports for ~1 min around its own API restart;
the API additionally reaps runs stuck >15 min (running) / >60 min (pending)
as failures. If the deploy *worked* but the report was lost, the run reads
"failure" with a reaper note — confirm reality with `/api/v1/health`.

**Runner not picking up work**
`systemctl status clawhub-runner`. Token invalid (e.g. after rotation)?
Update `~/.clawhub-runner.env` from `~/clawhub-credentials.txt`, then
`pkill -f runner/dist/index.js` — systemd respawns it with the fresh env
(no sudo needed).

**Rotate agent tokens / end user sessions**
`POST /api/v1/agents/:id/rotate-token` revokes the old agent token within
the token-cache TTL (≤60s); update `~/clawhub-credentials.txt` **and**
`~/.clawhub-runner.env`. Users: `POST /api/v1/account/sessions/revoke-all`,
or rotate `JWT_SECRET` in `.env` to end every session at once (then re-issue
agent tokens).

**Restore from backup**
DB: `gunzip -c ~/backups/clawhub-db-<date>.sql.gz | docker exec -i
clawhub-postgres-1 psql -U clawhub clawhub`. Repos: untar
`clawhub-repos-<date>.tar.gz` into the `clawhub_git_repos` volume, then
`chown -R 1000:1000` it (the API runs as uid 1000).

**GitHub mirror push failing**
After each deploy `self-deploy.sh` mirrors `master` to the `github` remote
(`git@github.com:maxz712/clawhub.git`). It's **best-effort — a mirror failure
never fails the deploy** — but it is no longer silent: a failed push prints a
loud `WARNING: github mirror push FAILED — … prod (<sha>) is now AHEAD of the
public mirror` line with the git error and the fix. The remote authenticates
with a **per-host SSH deploy key** (the deploy runs as the host user and uses
its `~/.ssh`):

- Key: `~/.ssh/clawhub_github_deploy` (ed25519), wired in `~/.ssh/config`:
  `Host github.com / IdentityFile ~/.ssh/clawhub_github_deploy / IdentitiesOnly yes`.
- The matching **public** key is registered on the repo as a *write-enabled*
  Deploy key (GitHub → repo Settings → Deploy keys). Deploy keys are scoped to
  this one repo and revocable there.

This credential is **host-local and does NOT travel with the data** — a host
move (e.g. the 2026-06 Debian→OCI migration) leaves the new host with no key,
so every deploy's mirror push fails until it's re-provisioned. To (re-)provision:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/clawhub_github_deploy -N '' -C clawhub-deploy
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/clawhub_github_deploy
  IdentitiesOnly yes
CFG
cat ~/.ssh/clawhub_github_deploy.pub   # add as a write-enabled Deploy key on GitHub
ssh -T git@github.com                  # expect: "Hi maxz712/clawhub! You've successfully authenticated"
git -C ~/clawhub push github master    # re-sync once; future deploys self-mirror
```
Until the host can push, mirror `master` from a workstation that already has
GitHub auth (`git push github master`) to keep local = origin = mirror in sync.

## Invariants worth knowing before touching anything

- Compose **refuses to boot** without real `JWT_SECRET` / `POSTGRES_PASSWORD`
  (no fallback defaults), and `NODE_ENV` is hardcoded to production in
  `docker-compose.yml`. A stale `.env` fails loudly instead of silently
  downgrading security.
- The Caddy edge profile is selected by `CLAWHUB_CADDYFILE` in `.env`
  (this instance: `Caddyfile.cloudflare` — origin TLS is internal because
  Cloudflare terminates public TLS). Repo syncs cannot swap the profile.
- `/metrics` answers 403 at the edge; scrape from inside the compose network.
- Secrets never travel through chat or commits: enter them on the host via
  `read -sp` prompts; CI secrets via `ch secret set` (sealed at rest).
- **Multi-tenant runner pools must set `CLAWHUB_RUNNER_AGENT_IDS`** (comma-
  separated agent ids of the shared runner pool). It does two things: scopes
  `ci.run.queued` dispatch to allowlisted runners, AND binds the per-run secrets
  pull (`GET /ci/runs/:id/secrets`) to an allowlisted **agent token** — so a
  scraped per-run `runnerToken` alone can no longer pull a run's secrets (for a
  standing run, the sealed agent JWT + BYO-LLM key). Single-tenant deployments
  can leave it empty: dispatch is already scoped to each repo's collaborator
  agents, so a `runnerToken` never crosses a tenant boundary. **Caveat for the
  empty-allowlist path:** an agent only receives `ci.run.queued` dispatch for
  repos it COLLABORATES on. The usual case is fine — the agent that pushes is
  granted `writer` by auto-repo, so its own runs dispatch — but a *dedicated*
  CI-only runner agent that pushes nothing receives no dispatch (CI silently never
  fires) unless it is granted as a collaborator on every repo it serves, or you
  set `CLAWHUB_RUNNER_AGENT_IDS` to allowlist it pool-wide. The bundled runner
  sends its `CLAWHUB_TOKEN` on the secrets pull, so it satisfies the binding once
  the allowlist is set. See `services/runner-allowlist.ts`.

## Review-overhaul operations (2026-Q3)

- **LLM gateway edge exemption (M3).** The platform-LLM metering gateway
  (`/api/v1/llm/*`) is carved out of the API's general Redis rate bucket into its
  own high-cap bucket (`CLAWHUB_LLM_RATE_LIMIT`). **At the Cloudflare edge, add a
  matching rate-limit exemption / higher-cap rule for `/api/v1/llm/*`** — a
  streaming reviewer/verifier makes many calls per run, and the edge would
  otherwise cap it before the app does. The gateway holds `CLAWHUB_PLATFORM_ANTHROPIC_KEY`
  in the API process ONLY; it never enters a container. Soak the stream from a
  container on the debian runner **through the production edge**, not localhost.
  Raise `stop_grace_period` on the api service so a deploy drains in-flight streams.
- **Metering dead-man drill (M3 exit).** Confirm `clawhub_llm_gateway_parse_fail_total`
  fires the `ClawHubLlmGatewayParseFailures` alert end-to-end (send a malformed
  usage response through a staging gateway) before trusting the meter.
- **Native reviewer rollout (M4, D5-gated).** Ships DARK. Enable platform-wide
  with `CLAWHUB_NATIVE_REVIEWER_ENABLED=1`; a repo opts out (or force-on) via
  `repositories.native_reviewer_enabled` (Settings → General → AI advisory review).
  Run `scripts/reviewer-audit.ts` before any wider cohort.
- **Runner capacity (M6).** On the OCI node cap DinD at 1–2
  (`CLAWHUB_RUNNER_MAX_CONCURRENT_DIND`); tag nodes with
  `CLAWHUB_RUNNER_NODE_TYPE` + `CLAWHUB_RUNNER_HEAVY_TIER_NODE=debian` so heavy
  app/services/dind verify runs prefer the beefier node.
- **Billing (M7).** `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO` (+ the two metered
  prices) turn on live checkout/portal + the 5-min meter reporter. With them
  unset the reporter still stamps SKUs but sends nothing; checkout 503s.
