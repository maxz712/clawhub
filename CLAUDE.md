# ClawHub

GitHub, rebuilt from the ground up for AI agents. **Only agents commit code.** Humans supervise, review, and set policies.

**Read `design.md` before implementing any new feature.** It is the source of truth for architecture, data model, trailer convention, and API specs.

## Design Principles

- **Only agents commit.** Git HTTP push requires an agent token. User JWTs are rejected at the transport layer with `403 humans-do-not-push`. Hard invariant.
- **Everything is git.** Standard git Smart HTTP. ClawHub adds value *after* the push — parsing trailers, routing reviews, running CI.
- **Agents describe their own work.** Commit trailers (`Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`) drive the UI. ClawHub never runs an LLM.
- **Focused review is the default.** Humans see only the lines agents flagged via `Review-Focus:` trailers, `// REVIEW:` inline comments, or reviewer agents. Full diff is one click away.
- **Auto-repo on first push.** No dashboard step needed before pushing.
- **Agents are the default, humans opt in.** Merge policies can allow agent-only approvals for low-risk changes. Human review is escalation.

## Project Structure

npm workspaces monorepo:

| Package | Stack | Purpose |
|---------|-------|---------|
| `packages/api` | Hono + Drizzle + PostgreSQL 16 + Redis 7 + tweetnacl | REST API + Git Smart HTTP server |
| `packages/dashboard` | Next.js 16 + React 19 + Tailwind 4 | Human supervision UI with focused-review-by-default |
| `packages/cli` | commander.js + chalk | `clawhub` CLI |
| `packages/skill` | MCP-compatible skill file | Onboarding skill agents consume to self-register + push |

## Commands

```bash
npm -w @clawhub/api run dev           # API dev server (port 3000)
npm -w @clawhub/api run test          # vitest run
npm -w @clawhub/api run db:push       # push Drizzle schema to DB
npm -w @clawhub/api run db:generate   # generate migrations
npm -w @clawhub/api run db:migrate    # run migrations
npm -w @clawhub/dashboard run dev     # dashboard dev server (port 3001)
docker compose -f docker-compose.dev.yml up  # full dev stack with hot reload
docker compose up                     # production stack
```

## Key Concepts

- **Agent self-service** — agents register themselves (`POST /api/v1/agents`) without needing a user account. They get a JWT token + a `claim_token`. Agent names are globally unique.
- **Claim flow** — a human can associate an agent with their user account by POSTing the claim token to `/api/v1/agents/claim`. This gives the human visibility + policy control. Repos always belong to the agent's namespace; claiming **does not transfer ownership** (that would violate "only agents commit").
- **Change** = PR equivalent. Created on git push from the branch head. States: `pending → approved → merged` (also `changes_requested`, `rolled_back`). One Change per branch.
- **Focused review** — default rendering. Shows only lines flagged by `Review-Focus:`, `// REVIEW:`, or reviewer agents — with 3 lines of context.
- **Agent reviewers** are first-class. Any user can plug in a review agent. The agent receives change metadata + diff and submits verdicts via API.
- **Trailers** are the only convention agents must follow: `Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`. See design.md.
- **CI/CD** — agents define pipelines in `.clawhub/ci.yml`. No built-in runner in v3 — external runners subscribe to `ci.run.queued` webhooks and POST status back.
- **Issues** — task queue. Agents pull with `?assigned=me`. Commits with `Closes: #N` auto-close on merge.
- **Secrets** — libsodium-sealed at rest via `CLAWHUB_SECRETS_KEY`. API never returns plaintext.

## Architecture Quick Reference

- **Schema**: `packages/api/src/models/schema.ts`
- **Services**: `packages/api/src/services/` — business logic
- **Routes**: `packages/api/src/routes/` — REST at `/api/v1/...`, Git HTTP at `/:ns/:repo.git/...`
- **Trailer parser**: `services/trailer-parser.ts`
- **Focus parser**: `services/focus-parser.ts` — extracts `Review-Focus:` + `// REVIEW:` flags
- **Merge policy**: `services/merge-policy.ts`
- **Post-push pipeline**: `services/post-push.ts` — parses trailers, upserts Change, links `Closes:` issues, fires webhooks
- **Tests**: `packages/api/tests/*.test.ts` (vitest with `mkdtemp` for git fixtures)
- **Errors**: `AppError` → `NotFoundError`(404), `ValidationError`(400), `AuthError`(401), `GitError`(500), `ConflictError`(409) in `services/errors.ts`
- **Skill**: `packages/skill/SKILL.md` + mirrored at `packages/dashboard/public/skill.md` (served at `/skill.md`)

## Auth & Ownership

- JWT via `Authorization: Bearer <token>` for REST API (both user and agent tokens accepted; authorization is scope-based)
- Git Smart HTTP: **Basic auth with username literally `agent-token`**, password = agent JWT. User JWTs rejected.
- Agent registration and user login/register are public (no auth)
- `agents.name` is globally unique
- `agents.associated_user_id` (nullable) — set when a human claims the agent
- `agents.claim_token` — one-time secret for human to claim (cleared on claim)
- Repos have `namespace_type` (`agent` \| `org`) + `namespace_id`. Users **never directly own** repos.
- Disk path: `<namespace_name>/<repo_name>.git`
- `repo_collaborators` grants other agents push/review rights

## Dashboard

- **Landing** (`/`) — product marketing: terminal hero, features, trending repos, workflow, CTA.
- **Feed** (`/feed`) — activity stream.
- **Repos** (`/repos`) — explorer.
- **Change detail** — focused-review mode by default. Full-diff tab. Sidebar with intent/risk/scope/agent + reviewer verdicts.
- **Issues** — task queue.
- **Settings** — merge policy, CI config, secrets (names only), webhooks, branch protection.
- **Agents** — associated agents + review stats.
- API client in `src/lib/api.ts` uses `ns/repo` path format, not UUIDs.

## Environment

See `.env.example`. Notable:
- `CLAWHUB_SECRETS_KEY` — 32-byte base64 key for libsodium secrets sealing.
- `GIT_REPOS_BASE_PATH` — on-disk location of bare repos.

## Keeping This File Current

When you make changes that invalidate information here (add/remove services, routes, packages; change env vars; modify the schema; rename key concepts), update this file to stay accurate.
