# ClawForge

AI-native code hosting where agents are first-class citizens. Humans supervise, approve, and direct — agents do the work.

**Design principle: "Don't fight git, extend it."** Standard git transport works for every client. ClawForge layers agent metadata (intent, risk, permissions, audit trail) on top via the API.

**Read `design.md` before implementing any new feature or service.** It contains the full architecture, data model, and API specifications.

## Tech Stack

- **API**: Hono + Drizzle ORM + PostgreSQL 16 + Redis 7 (TypeScript, Node.js)
- **Dashboard**: Next.js 16 + React 19 + Tailwind CSS 4 + shadcn/ui (TypeScript)
- **CLI**: commander.js + chalk, published as `@clawforge/cli`
- **OpenClaw Skill**: MCP-compatible tool definitions, published as `@clawforge/openclaw-skill`
- **Monorepo**: npm workspaces — `packages/api`, `packages/dashboard`, `packages/openclaw-skill`, `packages/cli`

## Common Commands

```bash
# API
npm -w @clawforge/api run dev          # dev server (port 3000)
npm -w @clawforge/api run test         # vitest
npm -w @clawforge/api run db:push      # push Drizzle schema to DB
npm -w @clawforge/api run db:generate  # generate migrations
npm -w @clawforge/api run db:migrate   # run migrations

# Dashboard
npm -w @clawforge/dashboard run dev    # dev server (port 3001)

# CLI
npm -w @clawforge/cli run dev          # run CLI in dev mode

# OpenClaw Skill
npm -w @clawforge/openclaw-skill run dev  # run skill in dev mode

# Full stack
docker compose up
```

## Key Terminology

- **Change** — the equivalent of a PR. Agents submit changes, humans review them.
- **Intent Engine** — LLM classifier (OpenRouter + Claude Sonnet) that parses intent and assesses risk from commits/diffs.
- **Agent** — a first-class user type (OpenClaw, Claude Code, Cursor, or generic). Agents authenticate with JWT tokens.
- **Change Refs** — git refs at `refs/changes/<id>/head` and `refs/changes/<id>/merge` (trial merge).

## Data Model

Core entities: `Agent`, `User`, `Repository`, `Change`, `Review`, `PermissionRule`, `AuditEvent`. Schema defined in `packages/api/src/models/schema.ts`.

## API Patterns

- REST API at `/api/v1/...` — protected routes require JWT via `Authorization: Bearer <token>`
- Git Smart HTTP at `/:owner/:repo.git/...` — supports Basic auth and Bearer tokens, mounted before `/api/v1` routes
- Health check at `GET /health`
- Codebase Q&A at `POST /api/v1/repos/:id/ask` (requires OpenRouter API key)
- Commit history at `GET /api/v1/repos/:id/commits/:branch`

## Error Hierarchy

`AppError` (base) → `NotFoundError` (404), `ValidationError` (400), `AuthError` (401), `GitError` (500), `ConflictError` (409). Defined in `packages/api/src/services/errors.ts`.

## Service Layer (`packages/api/src/services/`)

| Service | Purpose |
|---------|---------|
| `git.ts` | `GitService` class — bare repo ops via `simple-git`, always resolves paths to absolute |
| `git-backend.ts` | `proxyToGitBackend()` — spawns `git-http-backend` CGI, parses CGI response |
| `intent.ts` | `IntentEngine` class — OpenRouter API (Claude Sonnet) for classification; heuristic fallback |
| `changes.ts` | `ChangeService` class — change lifecycle with state machine (pending→approved→merged) |
| `change-refs.ts` | `ChangeRefService` class — publishes/cleans up `refs/changes/` using git plumbing commands |
| `post-receive.ts` | `processIncomingPush()` — git push → Change record bridge with trailer parsing, REVIEW: comment scanning, agent identification |
| `trailer-parser.ts` | `parseTrailersFromBranch()` — parses git trailers (Intent, Risk, Scope, Review-Focus, Refs, Agent) from branch commits |
| `focus-parser.ts` | `parseReviewComments()` — scans diffs for `// REVIEW:` inline comments |
| `agent-identity.ts` | `identifyAgent()` — matches commits to agents via Agent trailer, git_author, or push identity |
| `merge-policy.ts` | `canMerge()` — evaluates repo merge policy (human approval, weighted approvals, auto-merge rules, path overrides) |
| `auto-repo.ts` | `resolveOrCreateRepo()` — auto-creates repos on push (checks can_create_repos, max_repos) |
| `reviews.ts` | `countReviewVerdicts()` — aggregates review counts |
| `permissions.ts` | `evaluatePermissions()` — glob-based permission rules (minimatch) |
| `events.ts` | `EventBus` class — Redis Streams with console-log fallback |
| `auth.ts` | JWT token generation/validation, password hashing (bcryptjs) |
| `errors.ts` | Typed error classes |

## Auth

- JWT tokens for all API access, `Authorization: Bearer <token>` header
- Basic auth for git operations (`agent-token:<jwt>` format)
- Agent registration and user register/login routes are public (no auth required)
- Only users (not agents) can approve, reject, merge, or rollback changes

## Events

Redis Streams (`clawforge:events`) for event publishing. Falls back to console logging when Redis is unavailable. SSE endpoint at `/api/v1/events/stream` for real-time dashboard updates.

## Change State Machine

```
pending → approved → merged → rolled_back
pending → rejected
approved → rejected
```

Auto-merge: if permissions allow auto-merge AND risk is low/medium AND no approval required, changes are automatically approved and merged.

## Testing

- Framework: vitest (v4), tests in `packages/api/tests/*.test.ts`
- Run: `npm -w @clawforge/api run test`
- Uses `mkdtemp` for temporary git test fixtures
- Dashboard has no tests currently — manual testing only

## Environment Variables

See `.env.example` for all vars: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `GIT_REPOS_BASE_PATH`, `OPENROUTER_API_KEY`, `PORT`, `NEXT_PUBLIC_API_URL`, `CLAWFORGE_API_URL`, `CLAWFORGE_TOKEN`.

## Docker

Multi-stage Dockerfile (`Dockerfile`): `node:20-slim` with `git` installed (provides `git-http-backend` at `/usr/lib/git-core/git-http-backend`). Production image runs `node packages/api/dist/index.js`.
