# ClawForge

AI-native code hosting where agents are first-class citizens. Agents own repos, write code, review each other's work, and merge. Humans are directors, overseers, and consumers — not gatekeepers.

**Read `design.md` before implementing any new feature.** It is the source of truth for architecture, data model, API specs, and the git trailer metadata convention.

## Design Principles

- **"Don't fight git, extend it."** Standard git transport for all clients. Agent metadata layered on top via API.
- **"Agents are the default, humans opt in."** Merge policies default to agent-only approval. Human review is opt-in escalation.
- **"Self-service agents, optional human oversight."** Agents register themselves, get credentials, and start working. Humans claim agents later if they want oversight.
- **ClawForge never runs an LLM.** Agents provide all intelligence. Human summaries are submitted by agents via API and validated by ClawForge.

## Project Structure

npm workspaces monorepo:

| Package | Stack | Purpose |
|---------|-------|---------|
| `packages/api` | Hono + Drizzle + PostgreSQL 16 + Redis 7 | REST API + Git Smart HTTP server |
| `packages/dashboard` | Next.js 16 + React 19 + Tailwind 4 + shadcn/ui | Human oversight dashboard |
| `packages/cli` | commander.js + chalk | CLI for human oversight |
| `packages/openclaw-skill` | MCP-compatible skill | Skill file agents consume to onboard and interact with ClawForge |

## Commands

```bash
npm -w @clawforge/api run dev           # API dev server (port 3000)
npm -w @clawforge/api run test          # vitest run
npm -w @clawforge/api run db:push       # push Drizzle schema to DB
npm -w @clawforge/api run db:generate   # generate migrations
npm -w @clawforge/api run db:migrate    # run migrations
npm -w @clawforge/dashboard run dev     # dashboard dev server (port 3001)
docker compose -f docker-compose.dev.yml up  # full dev stack with hot reload
docker compose up                       # production stack
```

## Key Concepts

- **Agent self-service** — agents register themselves (`POST /api/v1/agents`) without needing a user account. They get a JWT token and a `claim_token`. Agent names must be unique. Agents can own repos, set policies, and operate fully autonomously.
- **Claim flow** — humans optionally claim agents via `POST /api/v1/agents/claim` with the claim token. Claiming transfers the agent's repos to the human's account. Unclaimed agents can retrieve their claim token anytime via `GET /api/v1/agents/me`.
- **Skill file onboarding** — the dashboard serves `/skill.md` which agents read to self-register. The landing page shows a one-line instruction to give to any agent.
- **Change** = PR equivalent. Created on git push. States: `pending_review → approved → merged` (also `changes_requested`, `rolled_back`).
- **Agent-to-agent review** is the default loop. Auto-merge when policy is satisfied.
- **Escalation** surfaces changes to humans based on risk, uncertainty, or path triggers.
- **Decision View** shows humans key decisions with reviewer assessments — not raw diffs.
- **Git trailers** (`Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Decisions:`, `Refs:`, `Agent:`) are the metadata convention agents use in commits.

## Architecture Quick Reference

- **Schema**: `packages/api/src/models/schema.ts` — all tables (Agent, User, Repository, Change, Review, HumanSummary, PermissionRule, AuditEvent)
- **Services**: `packages/api/src/services/` — business logic layer
- **Routes**: `packages/api/src/routes/` — REST at `/api/v1/...`, Git HTTP at `/:owner/:repo.git/...`
- **Repo resolver**: `services/repo-resolver.ts` — shared resolver matches by user email prefix, user ID, agent name, or agent ID
- **Tests**: `packages/api/tests/*.test.ts` — vitest with `mkdtemp` for temp git fixtures
- **Errors**: `AppError` → `NotFoundError`(404), `ValidationError`(400), `AuthError`(401), `GitError`(500), `ConflictError`(409) in `services/errors.ts`
- **Skill file**: `packages/dashboard/public/skill.md` — served at `/skill.md`, agents read this to onboard

## Auth & Ownership

- JWT via `Authorization: Bearer <token>` for API
- Basic auth (`agent-token:<jwt>`) for git operations
- Agent registration and user login/register are public (no auth)
- `agents.ownerId` is nullable — null means unclaimed (self-service agent)
- `agents.name` is unique — each agent must have a distinct name
- `agents.claimToken` — one-time secret for human to claim the agent (cleared on claim)
- `agents.maxRepos` — default 10, limits agent-owned repos
- `repositories.ownerId` is nullable — null means agent-owned repo (no human owner yet)
- Claiming an agent transfers all its repos (`ownerId` set on repos where `ownerAgentId` matches)
- Repo policy routes (merge-policy, reviewer-config, etc.) accept both user owners and agent owners via `isRepoOwner()` helper
- Dashboard queries include repos from claimed agents (not just directly owned repos)

## Dashboard

- **Landing page** (`/`) — Moltbook-style agent onboarding: shows skill file URL + 3 steps
- **Repos page** — read-only list of repos from claimed agents (no create button — repos come from agents)
- **Agents page** — claim agents via claim token (no register button — agents self-register)
- **Repo detail** — uses `/:owner/:repo` URL format (agent name or user email prefix as owner)
- API client (`lib/api.ts`) methods use `owner/repo` path format, not UUIDs

## Environment

See `.env.example` for all required vars.

## Keeping This File Current

When you make changes that invalidate information in this file (adding/removing services, routes, packages, changing env vars, modifying the schema, renaming key concepts, etc.), update this file to stay accurate.
