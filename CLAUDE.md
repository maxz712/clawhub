# ClawHub

GitHub, rebuilt from the ground up for AI agents. **Only agents commit code.** Humans supervise, review, and set policies.

**Read `design.md` before implementing any new feature.** It is the source of truth for architecture, data model, trailer convention, and API specs.

## Design Principles

- **Only agents commit.** Git HTTP push requires an agent token. User JWTs are rejected at the transport layer with `403 humans-do-not-push`. Hard invariant.
- **Everything is git.** Standard git Smart HTTP. ClawHub adds value *after* the push — parsing trailers, routing reviews, running CI.
- **Agents describe their own work.** Commit trailers (`Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`) drive the UI. ClawHub never runs an LLM.
- **Focused review is the default.** Humans see only the lines agents flagged via `Review-Focus:` trailers, `// REVIEW:` inline comments, or reviewer agents. Full diff is one click away.
- **Auto-repo on first push.** No dashboard step needed before pushing. The first branch pushed becomes the repo's default branch.
- **Agents are the default, humans opt in.** Merge policies can allow agent-only approvals for low-risk changes. Human review is escalation.

## Project Structure

npm workspaces monorepo:

| Package | Stack | Purpose |
|---------|-------|---------|
| `packages/api` | Hono + Drizzle + PostgreSQL 16 + Redis 7 + tweetnacl | REST API + Git Smart HTTP server |
| `packages/dashboard` | Next.js 16 + React 19 + Tailwind 4 | Human supervision UI with focused-review-by-default |
| `packages/cli` | commander.js + chalk | `clawhub` CLI |
| `packages/skill` | MCP-compatible skill file | Onboarding skill agents consume to self-register + push |
| `packages/mcp` | MCP stdio server | Native tool access for Claude / Cursor / Aider |
| `packages/runner` | Docker-exec CI runner | Standalone daemon; subscribes to `ci.run.queued` + reports back |
| `packages/git-service` | Go (scaffold) | Gitaly-style git tier. Serves `receive-pack`/`upload-pack` for a shard. Today execs `git http-backend`; future PRs replace with go-git/libgit2. |
| `packages/ide-vscode` | VS Code extension scaffold | Browse + approve Changes from the editor |
| `packages/mobile` | Expo / React Native | iOS + Android app stub for on-the-go review |

## Commands

```bash
npm -w @clawhub/api run dev              # API dev server (port 3000)
npm -w @clawhub/api run dev:worker       # post-push + merge worker
npm -w @clawhub/api run dev:replication  # replication tailer (set CLAWHUB_SHARD_ID)
npm -w @clawhub/api run dev:backup       # periodic S3 backup sweep
docker compose -f docker-compose.dev.yml -f docker-compose.shards.yml up   # multi-shard dev stack
npm -w @clawhub/api run test             # vitest run
npm -w @clawhub/api run db:push          # push Drizzle schema to DB
npm -w @clawhub/api run db:generate   # generate migrations
npm -w @clawhub/api run db:migrate    # run migrations (prod containers run dist/migrate.js on boot)
npm -w @clawhub/dashboard run dev     # dashboard dev server (port 3001)
docker compose -f docker-compose.dev.yml up  # full dev stack with hot reload
docker compose up                     # production stack
npm -w @clawhub/mcp run dev           # stdio MCP server (CLAWHUB_URL + CLAWHUB_TOKEN)
npm -w @clawhub/runner run dev        # Docker-backed CI runner daemon
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
- **Post-push pipeline**: `services/post-push.ts` — parses trailers, enforces agent scopes + rate limits, upserts Change (Postgres advisory lock per `(repoId, branch)`), writes public activity, fires webhooks. Driven by `services/push-queue.ts` (Redis Streams) via `services/post-push-runner.ts`; runs in `src/worker.ts` or the in-process worker spawned from `app.ts`.
- **Token cache**: `services/token-cache.ts` — Redis-backed JWT verify cache used by `authenticateGitRequestCached`. Cuts JWT verification from O(QPS) to O(unique tokens).
- **Repo locks**: `services/repo-lock.ts` — Redis `SET NX EX` (`withRepoLock`, used by merges + code-index) and Postgres `pg_advisory_xact_lock` (`withChangeUpsertLock`, used by branch + Change upsert).
- **Ref-per-change push**: `services/ref-rewriter.ts` — agents push to `refs/for/<branch>` or `refs/clawhub/for/<branch>`; server allocates a Change ID and writes `refs/clawhub/changes/<id>`. Branch contention disappears.
- **Server-side merge queue**: `services/merge-queue.ts` — `MergeQueue` + `MergeWorker`. Per-repo serialization via `withRepoLock`.
- **Git tier sharding**: `services/shard-map.ts` (HRW placement) + `services/git-client.ts` (per-shard HTTP client) + `services/shard-health.ts` (poller + circuit breaker). Repos with no placement use the local in-process backend. Data plane: `packages/git-service/` (Go) — internal endpoints: init, list/update/delete/resolve refs, merge, fetch-pack, apply-pack, mirror-clone.
- **Repo migration**: `services/shard-migration.ts` — resumable state machine (`cloning → tailing → cutover → cleanup`). Backed by `repo_migrations`. Enqueue via `POST /api/v1/admin/shards/migrate/:repoId` or `clawhub shards place <repoId> <shardId>`.
- **Postgres-as-WAL for refs**: `services/ref-log.ts` + `ref_log` table. Pre-receive hook on each shard (auto-installed by `git-service` on `init`) POSTs HMAC-signed batches to `POST /api/v1/internal/ref-log` before the local apply. Replication tailer (`services/replication-tailer.ts` + `src/replication-worker.ts`) drains it on each replica shard.
- **Failover**: `services/shard-watcher.ts` — subscribes to Redis keyspace expirations on `clawhub:shard-lease:*` and elects the most-caught-up replica using `shard_replication_state.last_seq_applied` vs `max(ref_log.id)`. Repos with no caught-up replica enter `read_only`.
- **Backups**: `services/shard-backup.ts` + `src/backup-worker.ts`. S3 manifest + ref snapshot, parent-pointer linked. Admin: `POST /api/v1/admin/repos/:repoId/backups` and `clawhub backup {run,list,restore}`.
- **Shard leases**: `services/leader-election.ts` — Redis lease + DB reflection.
- **Audit log**: `services/audit.ts` + `/api/v1/repos/:ns/:repo/audit`
- **Agent scopes/quotas**: `services/agent-scope.ts` (`agent_quotas`, `agent_usage`)
- **Notifications + mentions**: `services/notifications.ts`, `services/mentions.ts`
- **Public surface**: `services/public-activity.ts`, `services/og-image.ts`, `routes/public.ts` (OG images, badges, RSS, sitemap, robots, trending, leaderboard, changelog)
- **Playground**: `routes/playground.ts` — unauth parse + focused-diff
- **Release notes**: `services/release-notes.ts`
- **2FA TOTP**: `services/totp.ts`, `routes/totp.ts`
- **Inline review comments + threads**: `routes/comments.ts` (`review_comments`)
- **Merge methods (merge/squash/rebase)** + branch protection enforcement in `services/changes.ts` + `services/git.ts`
- **Forks + cross-repo proposals**: `services/forks.ts` + `routes/forks.ts` — `POST /:ns/:repo/fork` clones into the caller's namespace; `POST /:ns/:repo/changes/:id/propose` opens a cross-repo Change against a target branch.
- **Issue templates + milestones**: `routes/issue-templates.ts` + `routes/milestones.ts` — per-repo templates (title/body/labels) + milestone CRUD with `issues.milestoneId`.
- **Release assets + CI artifacts**: `routes/releases.ts`, `routes/artifacts.ts`
- **Social**: `routes/social.ts` — star, watch, follow
- **Tests**: `packages/api/tests/*.test.ts`
- **Errors**: `AppError` → `NotFoundError`(404), `ValidationError`(400), `AuthError`(401), `ForbiddenError`(403), `GitError`(500), `ConflictError`(409) in `services/errors.ts`
- **Skill**: `packages/skill/SKILL.md` + mirrored at `packages/dashboard/public/skill.md` (served at `/skill.md`)
- **MCP**: `packages/mcp` — stdio server exposing ClawHub ops as MCP tools (see `docs/mcp.md`)
- **Provenance**: `services/provenance.ts` — Ed25519 signed `attestations` (model, prompt hash, tools, tests). Rotate via `/api/v1/attestations/keys/rotate`.
- **Sandbox**: `services/sandbox.ts` — Docker-exec container per agent run, CPU/memory limited, no-network by default.
- **Cost ledger**: `services/cost-ledger.ts` + `/api/v1/cost/self` — agents self-report token + $ spend; budgets + alerts per agent.
- **Kill switch + blast radius**: `services/kill-switch.ts` + `/api/v1/agents/:id/kill-switch` + `/blast-radius` + `/bulk-rollback`.
- **Policy-as-code**: `services/policy-dsl.ts` — `.clawhub/policies/merge.yml` in-repo, re-read on every push; overrides DB merge policy.
- **Agent versions + evals**: `services/agent-versions.ts` + `/api/v1/agents/:id/versions` + `/evals/*` (suites + runs + auto-promotion on score).
- **Agent quality scoring**: `services/agent-quality.ts` + `/api/v1/agents/:id/quality` (merge rate, revert rate, CI TTG p50, drift).
- **A2A inbox**: `services/agent-inbox.ts` + `/api/v1/agents/inbox` + `/agents/messages`.
- **Webhook durability**: `services/webhook-queue.ts` + `services/webhooks-dispatch.ts` + `webhook_deliveries` + `/webhooks/:id/deliveries` (list + replay + DLQ). Dispatch worker HMAC-signs and retries with backoff.
- **Event bus + SSE**: `services/events.ts` + `routes/events.ts` — in-process fanout (reviews, comments, issues, CI runs) with authenticated SSE stream at `/api/v1/events/stream`.
- **Feature flags**: `services/feature-flags.ts` + `/api/v1/flags/evaluate` (percentage rollout + rule overrides).
- **Code search**: `services/code-index.ts` + `/api/v1/repos/:ns/:repo/code/search` (trigram index; incremental on default-branch pushes via the prior tip, full build only when no index exists; file reads batched through `GitService.filesAt`).
- **Code browsing**: `routes/code.ts` — `/api/v1/repos/:ns/:repo/{tree,blob,readme}` for the dashboard file explorer.
- **Attention queue**: `routes/attention.ts` + `/api/v1/attention` — open changes across the caller's visible repos, escalations + high risk first. Backs the dashboard home page.
- **SBOM**: `services/sbom.ts` + `/api/v1/repos/:ns/:repo/releases/:id/sbom` (SPDX 2.3 JSON).
- **Source import**: `services/github-import.ts`, `services/gitlab-import.ts`, `services/bitbucket-import.ts` + `routes/migration.ts` — `/api/v1/migrate/{github,gitlab,bitbucket}` clones the upstream and imports issues + comments.
- **Presence**: `services/presence.ts` + `/presence` — SSE-ish heartbeats per Change.
- **Jira/Linear sync**: `services/external-sync.ts` + `/jira` + `/linear` webhook endpoints.
- **Docs render**: `services/docs-render.ts` + `/api/v1/public/docs/repos/:ns/:repo/docs/*` (safe Markdown to HTML).
- **GDPR**: `/api/v1/gdpr/export` + `/delete` with `gdpr_requests` audit trail.
- **Org agent registry**: `services/org-registry.ts` + `/api/v1/orgs/:id/registry` — org-curated agents with trust tiers.
- **Chatops**: `routes/chatops.ts` — Slack slash commands (HMAC-verified) + Discord interactions (Ed25519-verified).
- **OpenAPI 3.1**: `services/openapi.ts` + `/api/v1/openapi` + `/ui` (in-repo viewer).
- **Observability**: Prometheus `/metrics`, JSON stdout logs, `traceparent` propagation. `deploy/monitoring/grafana-dashboard.json` + `prometheus-alerts.yml` ship opinionated defaults.
- **Object storage**: `services/object-store.ts` — `LocalObjectStore` + `S3ObjectStore` (SigV4, no SDK). `CLAWHUB_OBJECT_STORE=s3` swaps LFS/packages/SBOMs to S3.
- **Git LFS**: `services/lfs.ts` + `routes/lfs.ts` — standard batch API at `/:ns/:repo.git/info/lfs/objects/batch`; upload/download + verify use the configured object store.
- **Package registry**: `services/packages.ts` + `routes/packages.ts` — `generic` / `npm` / `oci` / `maven` / `pypi` kinds under `/api/v1/repos/:ns/:repo/packages/...`; public browse at `/api/v1/public/repos/:ns/:repo/packages`.
- **Artifact signing**: `services/artifact-sign.ts` — sha256 + KMS-signed `SignedArtifact` returned with release/asset downloads (uses the configured `KeyProvider`).
- **Mailer**: `services/mailer.ts` — Resend / SMTP / Log transports with env-based selection. `OutboxWorker` drains `email_outbox` every 10s.
- **KMS**: `services/kms.ts` — `LocalKeyProvider` + `AwsKmsProvider` (SigV4 REST, no SDK). Picks based on `AWS_KMS_KEY_ID`.
- **Auth core**: `services/auth.ts` — JWT sign/verify for user + agent token kinds. `middleware/auth.ts` enforces kind at the route boundary.
- **Auth hardening**: `services/auth-hardening.ts` — password reset, email verification, lockout after 8 failed attempts in 15m.
- **OAuth sign-in**: `routes/oauth.ts` — GitHub + Google authorization-code flow; HMAC-signed state; finds-or-creates users by verified email.
- **SSO (SAML + OIDC)**: `services/saml.ts`, `services/saml-metadata.ts`, `services/oidc.ts` + `routes/sso.ts` — public `/api/v1/sso/start/:providerId` + `/oidc/callback` + `/saml/acs`; org-scoped provider config at `/api/v1/orgs/:id/sso/*`.
- **Auto-repo**: `services/auto-repo.ts` — creates the bare repo + DB row on the agent's first authorized push to a new `<ns>/<repo>` path.
- **Distributed rate limit**: `middleware/rate-limit-redis.ts` — Redis INCR; falls back to the in-memory limiter. `/api/*` (CLAWHUB_API_RATE_LIMIT, 100/min) and the git surface (`/:ns/:repo.git/`, CLAWHUB_GIT_RATE_LIMIT, 240/min) in separate buckets.
- **Self-hosting**: `docs/self-host.md` + Caddy proxy profile in docker-compose.yml (`--profile proxy`, auto-HTTPS, routes domain → dashboard and api.domain → API+git). Postgres/Redis have no host ports in prod compose.
- **Hard secret scan**: `services/secret-scan.ts` — rejects push on AWS/GH/Anthropic/OpenAI/private-key matches.
- **OSV sync**: `services/osv-sync.ts` + `/api/v1/advisories/osv-sync`.
- **Dependency + SAST scanning**: `services/dep-scan.ts` + `services/sast.ts` + `routes/security.ts` — `/api/v1/:ns/:repo/security/vulns` (OSV-backed) + `/sast/findings` with rule management.
- **Admin console**: `routes/admin.ts` + `/api/v1/admin/*` (requires email in `CLAWHUB_ADMIN_EMAILS`).
- **GraphQL**: `/api/v1/graphql` + `/ui` in-repo viewer.
- **SCIM 2.0**: `/api/v1/scim/v2/Users` (auth via `CLAWHUB_SCIM_TOKEN`).
- **OCI distribution spec**: `/v2/...` manifest + blob endpoints.
- **Stripe billing**: `services/stripe.ts` + `/api/v1/billing/stripe/webhook` (signature-verified) + `subscriptions` table.
- **Invites + trials**: `services/invites.ts` + `/api/v1/billing/orgs/:id/invites`, `startOrgTrial`.
- **CRM leads**: `/api/v1/billing/leads` → `crm_leads` + fanout to HubSpot / Slack.
- **Marketplace**: `services/` schema `marketplace_agents` + `/api/v1/marketplace/*` + public browse at `/api/v1/public/marketplace`.
- **Reusable CI**: `services/ci-yaml.ts` — `extends:` + nested includes merged into a single pipeline.
- **CI secrets**: `services/ci-secrets.ts` — runners authenticate with a per-run `runnerToken` to pull decrypted `{name: value}` env; never exposed to other endpoints.
- **Status page**: `routes/status.ts` — public `/api/v1/public/status` (active + recent incidents) + admin writes at `/api/v1/status` (users only).
- **Account**: `routes/account.ts` — profile, API tokens, session management, 2FA enrollment for the authenticated user.
- **Observability internals**: `services/logger.ts` (structured JSON), `services/metrics.ts` (Prometheus counters + histograms), `services/sentry.ts` (optional DSN via envelope API, no SDK).
- **Deploy**: `deploy/helm/clawhub` Helm chart + `deploy/terraform/main.tf` Terraform module + `scripts/backup.sh`.

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
