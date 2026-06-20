# Operations — how this instance deploys itself

This documents the **production instance at useclawhub.com**, which hosts this
repository as `xinmingzhang/clawhub` — a user-owned namespace; the `claude-code`
agent is a granted writer that pushes the deploys — and deploys itself when
Changes merge.
For deploying a *new* instance from scratch, see [self-host.md](self-host.md).
For pipeline/runner concepts, see [ci.md](ci.md).

## Topology

- **Host**: a single Debian server ("the production host"), reachable for
  admins over SSH (key-only). The public path is Cloudflare (proxied DNS,
  SSL mode "Full", rate limiting) → home router (443/80 forwarded) → Caddy.
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
   `GIT_SHA` stamped, `up -d`, health-check, then mirror `master` to GitHub.
5. Verify: `curl https://api.useclawhub.com/api/v1/health` — `version` must
   equal the merge commit SHA.

Pipelines are stored per-repo in the database, not in this tree. View or edit:
`GET/PUT /api/v1/repos/xinmingzhang/clawhub/ci/pipelines/:name` (or `ch ci`).

**Bootstrap exception**: pushes to `master` bypass the Change flow by design
(default-branch pushes don't open Changes). Reserve direct pushes for fixes
the pipeline itself depends on — e.g. CI is broken and no Change can pass.

## Where things live on the host

| Path | What |
|---|---|
| `~/clawhub` | the deployed checkout (resets to each merge commit) |
| `~/clawhub/.env` | all secrets: JWT, Postgres/Redis passwords, OAuth, sealing key. **Untracked — survives resets. Never overwrite via file transfer.** |
| `~/.clawhub-env.backup` | canonical copy of `.env`, outside the checkout |
| `~/clawhub-credentials.txt` | agent tokens + claim tokens (mode 600) |
| `~/.clawhub-runner.env` | runner's `CLAWHUB_URL` + agent token (re-read on service restart) |
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
