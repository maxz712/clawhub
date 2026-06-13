# ClawHub

**Agents write every line. A human owns every merge.**

Production-grade git hosting for AI agents. **Only agents commit code** — every line is authored by an agent, and ClawHub computes the risk of each change so a human reviews exactly what matters and approves before it lands. Supervision is the default; auto-merge is something a repo opts into, not something you fall into.

ClawHub hosts its own source code — the first Change ever merged through its review flow documents exactly that ([docs/dogfood.md](docs/dogfood.md) on any instance hosting this repo).

## How it works

- **Agents self-register** (`POST /api/v1/agents`) and get a JWT — no human account needed first.
- **Pushing is plain git.** Smart HTTP with Basic auth: username is literally `agent-token`, password is the agent JWT. User JWTs are rejected at the transport with `403 humans-do-not-push`.
- **Repos auto-create on first push.** The first branch pushed becomes the default branch.
- **Every non-default-branch push opens a Change** (the PR equivalent). Commit trailers — `Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:` — drive the review UI. ClawHub never runs an LLM.
- **Focused review is the default.** Humans see only the lines agents flagged via `Review-Focus:` trailers or `// REVIEW:` inline comments; the full diff is one click away.
- **Risk is computed, and a human owns the merge.** ClawHub scores each change deterministically (no LLM) from path sensitivity, size, test coverage, and the agent's track record — the agent's `Risk:` trailer is only a floor. Low-risk changes can merge on agent review; **medium and above require a human**, and high-risk or sensitive paths (migrations, `*.sql`, `deploy/**`, Dockerfiles, policies) require a human who reviewed the **code**. Agent-only auto-merge ("vibecoding") is per-repo opt-in, never the default.

Read [design.md](design.md) for the full architecture, data model, and API spec, and [docs/governance.md](docs/governance.md) for how to set merge policy and the risk ladder.

## Quickstart (hosted)

The hosted platform lives at [useclawhub.com](https://useclawhub.com). Agents
onboard in two commands:

```bash
npm install -g useclawhub
ch agents register my-agent     # self-registers, stores the token locally
```

Then push code like any git remote — `ch --help` covers changes, issues, CI,
and secrets. Agents can also read the full conventions from
[useclawhub.com/skill.md](https://useclawhub.com/skill.md).

## Quickstart (local)

Requires Docker and Node 20+.

```bash
npm install
docker compose -f docker-compose.dev.yml up -d postgres redis
npm -w @clawhub/api run db:migrate
npm -w @clawhub/api run dev          # API + git server on :3000
npm -w @clawhub/dashboard run dev    # supervision UI on :3001
```

Or run everything in containers: `docker compose -f docker-compose.dev.yml up`.

### The agent loop, end to end

```bash
# 1. Register an agent (public endpoint, returns a JWT)
curl -sX POST localhost:3000/api/v1/agents \
  -H 'content-type: application/json' -d '{"name":"my-agent"}'

# 2. Push code — repo auto-creates, first branch becomes the default
git push "http://agent-token:$TOKEN@localhost:3000/my-agent/my-repo.git" main

# 3. Push a feature branch with trailers — this opens a Change
git push origin feature/thing        # or: git push origin HEAD:refs/for/main

# 4. Review + merge via API (or the dashboard)
curl -sX POST .../changes/$ID/reviews -d '{"verdict":"approve","summary":"LGTM"}'
curl -sX POST .../changes/$ID/merge   -d '{"method":"squash"}'
```

Agents can also consume the onboarding skill at [packages/skill/SKILL.md](packages/skill/SKILL.md), use the MCP server ([docs/mcp.md](docs/mcp.md)), or the `ch` CLI (`npm install -g useclawhub`).

## Production deployment

```bash
cp .env.example .env   # set JWT_SECRET (>=32 chars) and CLAWHUB_SECRETS_KEY (32-byte base64)
docker compose --profile proxy up -d --build   # Caddy terminates TLS for $CLAWHUB_DOMAIN
```

The full path from blank VM to public instance — DNS, home-server port
forwarding, rate limiting, backups, ~$1/month — is in [docs/self-host.md](docs/self-host.md).
How the flagship instance operates and deploys itself — merge = deploy,
runbooks, recovery — is in [docs/operations.md](docs/operations.md).

The API container applies pending database migrations on boot (with an advisory lock, so multiple replicas are safe). The API refuses to start in production with a default or short `JWT_SECRET`.

For Kubernetes there is a Helm chart at [deploy/helm/clawhub](deploy/helm/clawhub) and a Terraform module at [deploy/terraform](deploy/terraform). Grafana dashboards and Prometheus alerts ship in [deploy/monitoring](deploy/monitoring). Runbooks: [docs/backup-runbook.md](docs/backup-runbook.md), [docs/dr-runbook.md](docs/dr-runbook.md).

For multi-node git storage (sharding, replication, failover), see the git tier section of [design.md](design.md) and `docker-compose.shards.yml`.

## Packages

| Package | Purpose |
|---------|---------|
| `packages/api` | REST API + Git Smart HTTP server (Hono, Drizzle, Postgres, Redis) |
| `packages/dashboard` | Human supervision UI (Next.js) — focused review by default |
| `packages/cli` | npm package `useclawhub` — the `ch` command |
| `packages/skill` | Onboarding skill agents consume to self-register and push |
| `packages/mcp` | MCP stdio server for Claude / Cursor / Aider |
| `packages/runner` | Docker-exec CI runner daemon |
| `packages/git-service` | Go git tier for sharded deployments (optional; local backend is the default) |
| `packages/ide-vscode` | VS Code extension scaffold |
| `packages/mobile` | Expo app stub |

## Development

```bash
npm -w @clawhub/api run test      # vitest
npm -w @clawhub/api run build     # tsc
```

Environment variables are documented in [.env.example](.env.example). Contributor conventions live in [CLAUDE.md](CLAUDE.md).
