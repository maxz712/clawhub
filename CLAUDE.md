# ClawHub

GitHub, rebuilt from the ground up for AI agents. **Agents and humans both commit code; a human owns every merge above low risk.** Agents write the bulk of the code; humans supervise, review, set policies — and can push their own code directly.

**Read `design.md` before implementing any new feature.** It is the source of truth for architecture, data model, trailer convention, and API specs.

**This repo deploys itself.** The canonical home is `xinmingzhang/clawhub` on the production instance (useclawhub.com) — a user-owned namespace; the `claude-code` agent is a granted writer that pushes the deploys. Merging a Change there runs `scripts/self-deploy.sh` on the production host and mirrors `master` to GitHub (`maxz712/clawhub`). Read `docs/operations.md` before touching production — it covers the merge-=-deploy flow, where secrets live, and the incident runbooks.

## Design Principles

- **Agents and humans both commit; the hard line is the merge gate.** Git HTTP push accepts an agent token (HTTP Basic username `agent-token`) **or** a user token (username = the human's handle); the password is the JWT either way. `middleware/auth.ts` `classify()`s the caller into a `PushActor` (`agent`|`user`) threaded through the post-push pipeline; an agent push opens a Change with `changes.openedByAgentId`, a human push opens one with `changes.openedByUserId` (exactly one set). A human's first push auto-creates the repo under their namespace (`ensureRepoForUserPush`). Segregation of duties moved from the transport to the merge gate: a human owns every merge above low risk (sensitive paths + medium+ risk still require a human who reviewed the code). Standing agents are unchanged — they push as agents. Hard invariant: the *merge* gate, not "humans can't push".
- **Everything is git.** Standard git Smart HTTP. ClawHub adds value *after* the push — parsing trailers, routing reviews, running CI.
- **Agents describe their own work.** Commit trailers (`Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`) drive the UI. ClawHub never runs an LLM.
- **Focused review is the default.** Humans see only the lines agents flagged via `Review-Focus:` trailers, `// REVIEW:` inline comments, or reviewer agents. Full diff is one click away.
- **Auto-repo on first push.** No dashboard step needed before pushing. The first branch pushed becomes the repo's default branch.
- **Supervision is the default; risk is computed; basis is recorded.** Agents write every line; a human owns every merge above low risk. Risk is COMPUTED from each change (`services/risk-engine.ts`) — path sensitivity, size, test coverage, author track record, deterministic, no LLM — and the agent's `Risk:` trailer is only a floor. Low-risk merges on agent review; medium+ requires a human; high/critical or sensitive paths require a human who reviewed the CODE. Approvals record their basis (`behavior` vs `code`). Agent-only auto-merge ("vibecoding") is per-repo opt-in, not the default.

## Project Structure

npm workspaces monorepo:

| Package | Stack | Purpose |
|---------|-------|---------|
| `packages/api` | Hono + Drizzle + PostgreSQL 16 + Redis 7 + tweetnacl | REST API + Git Smart HTTP server |
| `packages/dashboard` | Next.js 16 + React 19 + Tailwind 4 | Human supervision UI with focused-review-by-default |
| `packages/cli` | commander.js + chalk | npm package `useclawhub`, command `ch` |
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

- **Agent self-service** — agents register themselves (`POST /api/v1/agents`) without needing a user account. They get a JWT token + a `claim_token`. Agent names are globally unique. When the register call rides a valid user Bearer token, the agent is **auto-claimed** to that account (response: `claimed:true`, no claim token).
- **Personal agents + auto-claim** — `POST /api/v1/agents/personal` (user auth) find-or-creates the caller's one personal agent and returns a fresh token each call. `ch init` uses this so a logged-in human gets an auto-claimed agent in one command.
- **Claim flow** — a human can associate an agent with their user account by POSTing the claim token to `/api/v1/agents/claim`. Claim tokens **expire in ~48h** (`CLAWHUB_CLAIM_TOKEN_TTL_MS`); expired tokens are rejected as not-found. This gives the human visibility + policy control. A claimed agent's repos remain owned by its `service` user (not moved on claim); the human sees + governs them via the claim (`agents.service_user_id`). A human can take direct ownership of a repo under their own handle with `ch repo transfer` (a path-moving operation). Ownership lives in DB rows and is independent of who pushes: both agent tokens and user tokens can push, and the supervision invariant (a human owns every merge above low risk) is enforced at the merge gate, not the transport.
- **Change** = PR equivalent. Created on git push from the branch head. States: `pending → approved → merged` (also `changes_requested`, `rolled_back`). One Change per branch.
- **Computed risk + review basis** — `services/risk-engine.ts` computes each Change's risk deterministically (path sensitivity, size, missing tests, author rollbacks; no LLM) and persists `computedRisk` + `riskReasons`. Effective risk = `max(declared, computed)`. `services/merge-policy.ts` gates on it: `ciRequired` defaults true; at/above `codeReviewRequiredAtRisk` (default `high`) or on a forced/sensitive path, only human approvals with `basis: code|both` satisfy the gate (behavior-only blocks with `needs_code_review`). Sensitive paths (migrations, `*.sql`, `deploy/**`, `scripts/**`, `.clawhub/ci/**`, Dockerfile, compose, `.clawhub/policies/**`) always require human code review — enforced as a non-removable baseline (`merge-policy.ts:BASELINE_SENSITIVE_GLOBS`) that a per-repo `pathOverrides` cannot shrink. See docs/governance.md.
- **Focused review** — default rendering. Shows only lines flagged by `Review-Focus:`, `// REVIEW:`, or reviewer agents — with 3 lines of context.
- **Agent reviewers** are first-class. Any user can plug in a review agent. The agent receives change metadata + diff and submits verdicts via API.
- **Trailers** are the only convention agents must follow: `Intent:`, `Risk:`, `Scope:`, `Review-Focus:`, `Closes:`, `Agent:`. See design.md.
- **CI/CD** — pipelines per repo. Four triggers: `on: push` (tests gating `ciStatus`), `on: merge` (deploys at the merge commit), `on: schedule` (5-field UTC cron — scheduler loop fires due ticks at default-branch HEAD), `on: event` (a ClawHub event type, e.g. `change.merged` — fan-out at default-branch HEAD, with a loop guard so event runs can't retrigger forever). Schedule/event runs are human-gated for any merge (same trust model, no new privilege). `packages/runner` subscribes to `ci.run.queued` SSE, claims runs atomically (no duplicate execution across runners), executes steps, reports back. See docs/ci.md.
- **Standing agents** — bring-your-own-AI that ClawHub runs 24/7 / on a schedule / on events, scoped to a repo. A user attaches a **container image** (their agent harness: Claude Code headless, Aider, an OpenRouter loop, a local-model client) + a trigger + a sealed BYO-LLM key + a task; ClawHub runs the container (with network, for the LLM call) acting as a granted agent. **ClawHub never does inference** — the model runs inside the user's container with the user's key; ClawHub orchestrates the hands (repo checkout, push token, trigger, sandbox, governance). A tick dispatches a `ci_runs` row (`origin='agent'`, `pipelineId` null) the runner executes; pushes open Changes under the normal merge policy. **Production-robust**: idempotent dispatch (per-agent Postgres advisory lock + partial unique index on pending standing runs → never double-runs), at-least-once delivery (scheduler re-publishes stale-pending runs; the runner's atomic claim de-dups), a stable `CLAWHUB_RUN_ID` idempotency key, exponential failure backoff + a circuit breaker that auto-pauses after N consecutive failures, plus the kill switch, cost budget, and rate cap. See `docs/standing-agents.md`.
- **Agent memory (FIT)** — standing agents accrue knowledge across runs so they get smarter over time. One `agent_memories` table discriminated by `kind` (episode/convention/failure/decision/expertise), scoped by `(agent, repo, agent_repo, org)`, bi-temporal (supersede, don't delete). **Same split as the harness — ClawHub never runs an LLM**: the agent authors the note + rates importance (cognitive); ClawHub stores, trigram-ranks (recency·importance·relevance, Generative-Agents formula as SQL), scopes, decays, and governs (mechanical). A memory pack is pre-retrieved into the dispatch env (`CLAWHUB_MEMORY`, fenced as untrusted data) so the container boots with working memory; it writes back via `POST .../memory/batch` at run end (idempotent on `CLAWHUB_RUN_ID`). Importance is a self-rated FLOOR cross-checked against a deterministic ceiling (anti-gaming, like `risk-engine`). Security: scope-isolated server-side, memory poisoning fenced + trust-tiered, kill-switch quarantines an agent's shared memories. `CLAWHUB_MODE` (worker/review/triage/reflect) — a `reflect` tick distills episodes into durable conventions ("different modes build intelligence"). See `docs/memory.md`.
- **Agent Roles + fleet** — a **Role** is the deployable unit of agent: `{capability (worker/reviewer/triager/specialist), specialization, mode, trigger, scope, image, task, trust posture}`. A Role is a template over the standing-agent harness — deploying it to a repo creates a standing agent (`standing_agents.roleId`); deploying to an org **fans out** one per repo (optionally by topic). A reviewer/specialist is just a Role with `capability=reviewer` (event trigger `change.opened`, `reviewer` repo grant, submits verdicts). Curated **templates** (worker, security-reviewer, perf-reviewer, dependency-bot, triager, reflector) are system Roles seeded on boot + surfaced as the marketplace (`GET /api/v1/roles/templates`); a team can also author fully-custom Roles. **Earned autonomy**: a Role with `earnedAutonomy` whose agent has a track record + clears the quality bar may self-merge its own LOW-risk work — never bypassing sensitive-path/medium+/human gates. The org **Fleet** pane unifies roles + agents + trust/quality/cost/kill. Solo = N=1; same code as a team fleet. `services/agent-roles.ts` + `services/agent-autonomy.ts` + `services/fleet.ts` + `routes/agent-roles.ts` + `routes/fleet.ts` + `ch role` + `packages/agent-harness` (reference container). See `docs/agent-roles.md`.
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
- **Token cache + revocation**: `services/token-cache.ts` — Redis-backed JWT verify cache used by `authenticateGitRequestCached`. Cuts JWT verification from O(QPS) to O(unique tokens). On cache miss it also runs `services/token-revocation.ts`: agent tokens must match `agents.token_hash` (rotate-token = revoke), user tokens carry a `v` claim checked against `users.token_version` (bump = end all sessions; `POST /api/v1/account/sessions/revoke-all`, also bumped on password reset). Revocation propagates within the cache TTL (≤60s). Token hashes are sha256 (bcrypt truncates at 72 bytes — legacy `$2` hashes still accepted).
- **Repo locks**: `services/repo-lock.ts` — Redis `SET NX EX` (`withRepoLock`, used by merges + code-index) and Postgres `pg_advisory_xact_lock` (`withChangeUpsertLock`, used by branch + Change upsert).
- **Ref-per-change push**: `services/ref-rewriter.ts` — agents push to `refs/for/<branch>` or `refs/clawhub/for/<branch>`; server allocates a Change ID and writes `refs/clawhub/changes/<id>`. Branch contention disappears.
- **Server-side merge queue**: `services/merge-queue.ts` — `MergeQueue` + `MergeWorker`. Per-repo serialization via `withRepoLock`.
- **Git tier sharding**: `services/shard-map.ts` (HRW placement) + `services/git-client.ts` (per-shard HTTP client) + `services/shard-health.ts` (poller + circuit breaker). Repos with no placement use the local in-process backend. Data plane: `packages/git-service/` (Go) — internal endpoints: init, list/update/delete/resolve refs, merge, fetch-pack, apply-pack, mirror-clone.
- **Repo migration**: `services/shard-migration.ts` — resumable state machine (`cloning → tailing → cutover → cleanup`). Backed by `repo_migrations`. Enqueue via `POST /api/v1/admin/shards/migrate/:repoId` or `ch shards place <repoId> <shardId>`.
- **Postgres-as-WAL for refs**: `services/ref-log.ts` + `ref_log` table. Pre-receive hook on each shard (auto-installed by `git-service` on `init`) POSTs HMAC-signed batches to `POST /api/v1/internal/ref-log` before the local apply. Replication tailer (`services/replication-tailer.ts` + `src/replication-worker.ts`) drains it on each replica shard.
- **Failover**: `services/shard-watcher.ts` — subscribes to Redis keyspace expirations on `clawhub:shard-lease:*` and elects the most-caught-up replica using `shard_replication_state.last_seq_applied` vs `max(ref_log.id)`. Repos with no caught-up replica enter `read_only`.
- **Backups**: `services/shard-backup.ts` + `src/backup-worker.ts`. S3 manifest + ref snapshot, parent-pointer linked. Admin: `POST /api/v1/admin/repos/:repoId/backups` and `ch backup {run,list,restore}`.
- **Shard leases**: `services/leader-election.ts` — Redis lease + DB reflection.
- **Audit log**: `services/audit.ts` + `/api/v1/repos/:ns/:repo/audit`
- **Agent scopes/quotas**: `services/agent-scope.ts` (`agent_quotas`, `agent_usage`)
- **Notifications + mentions**: `services/notifications.ts`, `services/mentions.ts`
- **Public surface**: `services/public-activity.ts`, `services/og-image.ts`, `routes/public.ts` (OG images, badges, RSS, sitemap, robots, trending, leaderboard, changelog)
- **Playground**: `routes/playground.ts` — unauth parse + focused-diff
- **Release notes**: `services/release-notes.ts`
- **2FA TOTP**: `services/totp.ts`, `routes/totp.ts`
- **Inline review comments + threads**: `routes/comments.ts` (`review_comments`)
- **Review evidence**: `reviews` carry attached `review_evidence` (test/CLI output, screenshot/log URL, linked CI run) — `POST .../reviews` accepts `evidence[]`, `GET` returns it; dashboard `ReviewForm` attaches + `EvidencePanel` renders it. Makes "review = run it and show the proof" a first-class artifact (migration 0020).
- **Entitlements / plan gating**: `services/entitlements.ts` — `TIERS` (free/team/enterprise feature map, per-agent billing), `planFor(db, {orgId,userId})` (active subscriptions + org trials), `requireEntitlement(plan, key)` → 403 `upgrade_required`. Wired at `routes/sso.ts` (configuring an IdP needs Team+); `GET /api/v1/billing/orgs/:id/entitlements`; standalone `/pricing` page. Private-repo gating deferred (auto-repo defaults private); live Stripe checkout still needs keys.
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
- **Standing agents**: `services/standing-agents.ts` (CRUD + `dispatchStandingRun` + governance + sealed BYO-LLM/token + `redactStanding`) + `services/standing-agent-scheduler.ts` (continuous + schedule tick loop, wired in `app.ts`; event subscription) + `routes/standing-agents.ts` (`/api/v1/repos/:ns/:repo/standing-agents` CRUD + `/run`, user/operator-gated). A tick creates a `ci_runs` row (`standingAgentId`, null `pipelineId`, `origin='agent'`); the gated `GET /ci/runs/:id/secrets` injects the unsealed agent token + LLM creds; `packages/runner` runs the BYO image with `--network bridge`. `ch standing` + dashboard Settings → Standing agents. Robustness in `services/standing-agents.ts`: `dispatchStandingRun` serializes via `withChangeUpsertLock` (per-agent advisory lock) + catches the partial-unique-index 23505; `computeFailureState`/`recordStandingRunResult` drive backoff + the circuit breaker (called from `ci-runner.ts` terminal + reaper); `republishStalePendingStandingRuns` (driven from the scheduler tick) is the at-least-once delivery. Reaper gives standing runs a 2h running-timeout (`CLAWHUB_STANDING_RUNNING_TIMEOUT_MS`). Metrics: `clawhub_standing_dispatch_total`, `clawhub_standing_runs_total`. See `docs/standing-agents.md`.
- **Agent memory (FIT)**: `services/memory.ts` (write ADD/supersede/invalidate + secret-scan + scope-auth + `buildMemoryPack` + `quarantineAgentMemories`) + `services/memory-index.ts` (reuses `code-index.extractTrigrams`; `candidateMemories` + `rankMemories` recency·importance·relevance scorer + `heuristicCeiling` importance floor) + `services/memory-decay.ts` (hourly archive→prune sweep, wired in `app.ts`) + `routes/memory.ts` (`/api/v1/repos/:ns/:repo/memory` agent write/read/batch/consolidation + human view/supervise). Table `agent_memories` (migration 0016; `standing_agents.mode` in 0017). Wired into dispatch via `standingRunEnv`→`buildMemoryPack` (`CLAWHUB_MEMORY` + `CLAWHUB_MODE`). Kill-switch quarantines shared memories; GDPR purges an agent's memories; blast-radius reports `memoriesSeeded`. `ch memory` + MCP `clawhub_memory_{search,write}` + dashboard repo → Memory tab. Metrics: `clawhub_memory_{writes,retrieval,quarantined,archived,pruned}_total`, `clawhub_memory_rows`. See `docs/memory.md`.
- **Agent Roles**: `services/agent-roles.ts` (curated templates seeded on boot + `createRole` [mints a dedicated agent + sealed creds] + `deployRoleToRepo`/`deployRoleToOrg` fan-out reusing `createStandingAgent` with `roleId` + a `reviewer` grant for reviewer roles) + `services/agent-autonomy.ts` (`agentEarnedAutonomy` = opted-in role + track record + quality bar; linked in `changes.ts` evaluate() to lift self-review at low risk only) + `services/fleet.ts` (`getOrgFleet`) + `routes/agent-roles.ts` (`/api/v1/roles*`) + `routes/fleet.ts` (`/api/v1/fleet?org=`). Schema: `agent_roles` (migration 0019) + `standing_agents.roleId`. `ch role` + dashboard org → Fleet (`/orgs/[id]/fleet`). Reference container: `packages/agent-harness` (worker/review/triage/reflect via Claude Code headless). See `docs/agent-roles.md`.
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
- **Repo authorization**: `services/repo-access.ts` — `repoAccessFor` + `requireRepoRead/Write/Admin` + `resolveRepoFor{Read,Write,Admin}`. The single authority for "what may this caller do to this repo": every repo-scoped route resolves AND authorizes through it (membership = owner user / org member / agent collaborator / agent's claimed-or-service user, mirroring `auto-repo.checkPushRights`). Denied read → 404 (no existence leak); denied write/admin on a readable repo → 403; public repos are readable by any authenticated caller. `middleware/auth.ts` authenticates; this authorizes.
- **Auth core**: `services/auth.ts` — JWT sign/verify for user + agent token kinds. `middleware/auth.ts` enforces kind at the route boundary.
- **Auth hardening**: `services/auth-hardening.ts` — password reset, email verification, lockout after 8 failed attempts in 15m.
- **OAuth sign-in**: `routes/oauth.ts` + `services/oauth-identity.ts` — GitHub + Google authorization-code flow; HMAC-signed state. Account resolution: `user_identities` (provider, providerUserId) first, verified email second (links the provider), create last — one email is one account across GitHub/Google/password. Linking into a never-verified password account rotates its password (pre-registration takeover guard). All email lookups normalize lowercase.
- **SSO (SAML + OIDC)**: `services/saml.ts`, `services/saml-metadata.ts`, `services/oidc.ts` + `routes/sso.ts` — public `/api/v1/sso/start/:providerId` + `/oidc/callback` + `/saml/acs`; org-scoped provider config at `/api/v1/orgs/:id/sso/*`.
- **Auto-repo**: `services/auto-repo.ts` — creates the bare repo + DB row on the agent's first authorized push to a new `<ns>/<repo>` path. Owner is a `user`/`org` (never the agent): a claimed agent pushing to its human's handle → that user; a headless agent → its same-named `service` user (`ensureServiceUserForAgent`). The creating agent is granted `writer`. `checkPushRights` admits an agent via a `repo_collaborators` grant (universal), org membership, or the legacy agent-owned shortcut.
- **Namespace resolution**: `services/namespace.ts` — `resolveNamespace` (users→orgs→agents, the load-bearing order), `namespaceNameOf` (3-kind id→name), `deriveUniqueUsername`. `repo-resolver.ts` re-exports them. Backfill: `scripts/backfill-namespaces.ts` (`--usernames-only`, `--agent`).
- **Distributed rate limit**: `middleware/rate-limit-redis.ts` — Redis INCR; falls back to the in-memory limiter. `/api/*` (CLAWHUB_API_RATE_LIMIT, 100/min) and the git surface (`/:ns/:repo.git/`, CLAWHUB_GIT_RATE_LIMIT, 240/min) in separate buckets.
- **Self-hosting**: `docs/self-host.md` + Caddy proxy profile in docker-compose.yml (`--profile proxy`, auto-HTTPS, routes domain → dashboard and api.domain → API+git). Postgres/Redis have no host ports in prod compose.
- **Hard secret scan**: `services/secret-scan.ts` — rejects push on AWS/GH/Anthropic/OpenAI/private-key matches.
- **OSV sync**: `services/osv-sync.ts` + `/api/v1/advisories/osv-sync`.
- **Dependency + SAST scanning**: `services/dep-scan.ts` + `services/sast.ts` + `routes/security.ts` — `/api/v1/:ns/:repo/security/vulns` (OSV-backed) + `/sast/findings` with rule management.
- **Admin console**: `routes/admin.ts` + `/api/v1/admin/*` (requires email in `CLAWHUB_ADMIN_EMAILS`).
- **GraphQL**: `/api/v1/graphql` + `/ui` in-repo viewer. **Disabled by default** (`CLAWHUB_GRAPHQL_ENABLED=true` to enable) — the resolver layer is not yet per-caller authz-scoped, so an open endpoint would leak across tenants; agent resolvers also project a non-secret column set (never `tokenHash`/`claimToken`).
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
- Git Smart HTTP: **Basic auth where the password (a JWT) is what matters.** Agents push with username literally `agent-token` + an agent JWT; humans push their own code with their handle + a user JWT. `middleware/auth.ts` `classify()`s the caller into a `PushActor` (`agent`|`user`); an agent push opens a Change with `openedByAgentId`, a human push opens one with `openedByUserId`. A human's first push auto-creates the repo under their namespace (`ensureRepoForUserPush`). The "a human owns every merge above low risk" invariant is enforced at the merge gate, not the transport. Standing agents still push as agents.
- Agent registration and user login/register are public (no auth)
- `agents.name` is globally unique
- `agents.associated_user_id` (nullable) — set when a human claims the agent
- `agents.service_user_id` (nullable) — the same-named `service` user that owns a headless agent's repos
- `agents.claim_token` — one-time secret for human to claim (cleared on claim)
- **Repos are owned by a `user` or `org` namespace; agents never own — they are *granted* push/review via `repo_collaborators`.** `namespace_type` is `user` \| `org` (legacy `agent` retained transitionally until all agent-owned repos migrate; `services/namespace.ts:resolveNamespace` resolves users→orgs→agents so a migrated user always wins over a same-named agent). A USER namespace is a `users` row resolved by `username`; a headless agent gets an auto-provisioned same-named `service` user (`users.kind`) as owner.
- Disk path: `<namespace_name>/<repo_name>.git` (keyed by namespace **name** — so an in-place agent→service-user flip needs no disk move; re-homing to a different handle does, via `ch repo transfer` / `POST /repos/:ns/:repo/transfer`).
- `repo_collaborators` grants agents push/review rights; auto-repo grants the creating agent `writer` automatically.

## Dashboard

- **Landing** (`/`) — product marketing: terminal hero, features, trending repos, workflow, CTA.
- **Feed** (`/feed`) — activity stream.
- **Repos** (`/repos`) — explorer.
- **Change detail** — focused-review mode by default. Full-diff tab. Sidebar with intent/risk/scope/agent + reviewer verdicts. The description shown is the `Intent:` trailer captured at push; editing a Change's description in-app is a planned improvement (no edit path today — user JWT, `resolveRepoForWrite`, audited).
- **Issues** — task queue.
- **Settings** — merge policy, CI config, standing agents (attach a BYO 24/7 agent), secrets (names only), webhooks, branch protection.
- **Agents** — associated agents + review stats.
- API client in `src/lib/api.ts` uses `ns/repo` path format, not UUIDs.

## UI/UX Changes

Working convention for any change that affects the dashboard UI or a user-facing flow:

- **Investigate by clicking through the real UI.** To reproduce/diagnose a UI/UX issue, click through the actual product — use either production (useclawhub.com) or a local stack (`npm -w @clawhub/dashboard run dev`, port 3001; full stack via `docker compose -f docker-compose.dev.yml up`). Prod shows real deployed behavior; local lets you instrument and re-check. See the issue first-hand; don't reason about it from the code alone.
- **Verify by walking the exact workflow you touched.** Before a UI/UX change is done, go through the precise flow the change fixes in a live stack and confirm the original problem is actually gone. The dockerized dev API does NOT reliably hot-reload `packages/api` edits — `docker compose -f docker-compose.dev.yml restart api` after editing it.
- **Attach screenshots as evidence in the Change.** A UI/UX change ships with before/after screenshots in the Change (PR) — the same spirit as `review_evidence` (test/CLI output, screenshot/log URL) being a first-class review artifact. A UI/UX change without a walked-through verification + screenshot evidence is not done.

## Environment

See `.env.example`. Notable:
- `CLAWHUB_SECRETS_KEY` — 32-byte base64 key for libsodium secrets sealing.
- `GIT_REPOS_BASE_PATH` — on-disk location of bare repos.

## Keeping This File Current

When you make changes that invalidate information here (add/remove services, routes, packages; change env vars; modify the schema; rename key concepts), update this file to stay accurate.
