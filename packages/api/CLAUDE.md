# ClawHub API

Hono + Drizzle + PostgreSQL 16 + Redis 7 + tweetnacl. Serves the REST API **and** Git Smart HTTP on the same port.

## Entry points

- `src/index.ts` — instantiates `GitService` and `EventBus`, wires into `buildApp({ db, git, events })`, serves on `PORT`.
- `src/worker.ts` — standalone post-push worker. Drains the Redis Streams push queue + merge queue. Run with `npm -w @clawhub/api run dev:worker` (or `start:worker` in prod). The API process also runs an in-process worker by default; set `CLAWHUB_DISABLE_INPROC_WORKER=1` in prod to run workers standalone.
- `src/replication-worker.ts` — per-shard replication tailer. Reads `ref_log` for repos hosted on `$CLAWHUB_SHARD_ID` and applies them via the shard's gRPC/HTTP surface. Run one per replica shard.
- `src/backup-worker.ts` — periodic backup sweep. Iterates repos whose last backup is older than `CLAWHUB_BACKUP_INTERVAL_MS` (default 1h) and uploads manifests via the configured object store.
- `src/migrate.ts` — boot-time migrator (drizzle-orm programmatic migrate + Postgres advisory lock). The production container runs `node dist/migrate.js && node dist/index.js`; interchangeable with `npm run db:migrate`.
- `src/app.ts` — middleware + route mounting. LFS mounts before git-http at root — git-http's catch-all (`/:ns/:repo.git/*`) would otherwise swallow LFS paths.

## Route mount order

1. CORS (`*`)
2. **Git Smart HTTP at root** (`/:ns/:repo.git/*`) — owns its own auth via `authenticateGitRequest`.
3. Rate limiter on `/api/*`.
4. Public REST: `/api/v1/health`, `/api/v1/users` (login/register), `/api/v1/agents` (register), `/api/v1/ci/runs/:id` (runner callback).
5. Protected REST: everything else — uses `authMiddleware`, reads `tokenPayload` from context.
6. `app.onError(errorHandler)` maps `AppError` subclasses to HTTP codes.

## Git push auth

Git push uses HTTP Basic where the **password (a JWT) is what matters**, and `middleware/auth.ts` `classify()`s the caller into a `PushActor`:
- **Agents** push with username literally `agent-token` + an agent JWT (`{ kind: "agent", agentId }`).
- **Humans** push their own code with username = their handle + a user JWT (`{ kind: "user", userId }`).

Both are accepted and threaded through the same pipeline as a `PushActor`. See `middleware/auth.ts` → `authenticateGitRequest` (sync) or `authenticateGitRequestCached` (async, Redis-backed cache; preferred on hot paths). Segregation of duties is **not** at the transport — it's at the merge gate (a human owns every merge above low risk; sensitive paths + medium+ risk require a human who reviewed the code). Standing agents still push as agents.

On a successful push, `routes/git-http.ts` snapshots branch heads, proxies to `git http-backend`, and enqueues a `PushJob` (carrying the `PushActor`) on Redis Stream `clawhub:push:received`. A worker (`src/worker.ts` or the in-process worker in `app.ts`) calls `services/post-push-runner.ts` → `services/post-push.ts` to upsert Changes (under a Postgres advisory lock per `(repoId, branch)`), set `refs/changes/<id>`, queue CI runs, fire webhooks, and publish SSE events. An agent push sets `changes.openedByAgentId`; a human push sets `changes.openedByUserId` (exactly one). A human's first push to a new path auto-creates the repo under their own namespace via `ensureRepoForUserPush` (the human-side analogue of `auto-repo.ts`). Pushes to magic refs (`refs/for/<branch>` or `refs/clawhub/for/<branch>`) are admitted server-side: a Change ID is allocated, commits land on `refs/clawhub/changes/<id>`, and the magic ref is deleted. See `services/ref-rewriter.ts`.

If Redis is unreachable at enqueue time, `PushQueue` runs the registered in-process fallback so pushes are never silently dropped.

## Services

| Service | Purpose |
|---------|---------|
| `git.ts` | simple-git wrapper (bare repo ops, trial merge, merge commits). `filesAt` bulk-reads many paths via one `git cat-file --batch` process — use it instead of `fileAt` loops. |
| `git-backend.ts` | CGI proxy to `git http-backend` |
| `change-refs.ts` | `refs/changes/<id>` plumbing (execFile) |
| `auto-repo.ts` | First-push repo creation + permission check |
| `post-push.ts` | Parse trailers, upsert Change (under advisory lock), link `Closes:`, queue CI for `triggerKind='push'` pipelines only (`ciStatus=skipped` when none), fire events. Branch deletion retracts the branch's unmerged Change. First push to an empty repo adopts the pushed branch as default. |
| `post-push-runner.ts` | Bridge from `PushJob` to `processPush`. Detects magic refs and admits them via `ref-rewriter.ts`. |
| `push-queue.ts` | Redis Streams durable queue (`PushQueue` producer + `PushWorker` consumer group). Fail-open: enqueue runs in-process fallback when Redis is down. |
| `merge-queue.ts` | `MergeQueue` + `MergeWorker` — server-side serialized merges; per-repo lock via `withRepoLock`. |
| `ref-rewriter.ts` | Magic-ref intake (`refs/for/<branch>` → allocate Change ID + write `refs/clawhub/changes/<id>`). |
| `repo-lock.ts` | Redis `SET NX EX` per-repo lock (`withRepoLock`) + Postgres `pg_advisory_xact_lock(hash(repoId|branch))` (`withChangeUpsertLock`). |
| `token-cache.ts` | Redis-backed JWT verify cache (`verifyTokenCached`). 60s TTL by default; 5s in-process layer in front. |
| `shard-map.ts` | Repo → git-service shard resolution. Rendezvous (HRW) hashing for placement. Returns a synthetic `local` shard when nothing's placed yet. |
| `git-client.ts` | HTTP client for a git-service shard (`init`, `listRefs`, `updateRef`, `deleteRef`, `resolveRef`, `merge`, `fetchPack`, `applyPack`, `mirrorClone`, `forwardGitHttp`). Pooled by `GitClientPool`. |
| `shard-health.ts` | Periodic `/healthz` poller + per-shard circuit breaker (`closed → open → half_open`). |
| `shard-watcher.ts` | Phase 4 failover. Subscribes to Redis keyspace expirations on `clawhub:shard-lease:*` and elects the most-caught-up replica based on `ref_log` tip vs `shard_replication_state.last_seq_applied`. |
| `shard-migration.ts` | Resumable repo migration state machine: `cloning → tailing → cutover → cleanup`. Backed by `repo_migrations`. |
| `replication-tailer.ts` | Replica-side loop that tails `ref_log` for repos hosted here, pulls missing packs from the writer shard, and applies via `update-ref`. Updates `shard_replication_state`. |
| `shard-backup.ts` | S3-backed periodic backups. Per-repo manifest + ref snapshot; parent-pointer linked. Restore recreates the bare repo on a target shard. |
| `ref-log.ts` | Phase 4 Postgres-as-WAL writer + reader. Pre-receive hook on a shard POSTs HMAC-signed batches to `/api/v1/internal/ref-log` BEFORE the local apply. |
| `leader-election.ts` | Per-shard Redis lease loop + DB reflection (`git_shards.lease_holder`). |
| `shard-replication.ts` | Legacy: `git push --mirror` to a replica shard (dry-run by default). Superseded by `replication-tailer.ts`; kept while old scripts still call it. |
| `trailer-parser.ts` | `Intent`, `Risk`, `Scope`, `Review-Focus`, `Closes`, `Agent` |
| `focus-parser.ts` | Extract `// REVIEW:` inline comments |
| `risk-engine.ts` | `computeRisk({ declared, changedPaths, additions, deletions, agentPriorRollbacks }) → { risk, reasons }`. Deterministic, explainable (no LLM): path-taxonomy floors → size/no-test/rollback bumps → `max(declared, computed)`. Driven from `post-push.ts` (one `git.numstat`); persisted as `changes.computedRisk` + `riskReasons`. `isGeneratedFile`/`GENERATED_GLOBS` flag lockfiles/snapshots/build output — post-push subtracts their line counts from the SIZE metric (they still count for path floors), so a big generated `package-lock.json` doesn't force HIGH. Lockfiles are NOT in the MEDIUM floor; `package.json` (declares deps) is. |
| `ci.ts` | CI as config-as-code. `readRepoPipelines` collects `.clawhub/ci/*.yml` (+ `.clawhub/ci.yml`) at a commit (name = `name:` field, else filename); `upsertRepoPipeline`/`syncRepoPipelines` upsert each, deriving `triggerKind`/`triggerConfig` via `parsePipelineTrigger`. Called from `post-push.ts` on default-branch pushes only (same trust model as policy-as-code). Additive: never deletes DB-only pipelines. |
| `merge-policy.ts` | `evaluateMerge({ policy, risk, computedRisk?, scope, reviews, ciStatus, verifiedAttestation? }) → decision`. Effective risk = `max(risk, computedRisk)`. Reviews carry `basis: behavior\|code\|both`; at/above `codeReviewRequiredAtRisk` (default `high`) or on a forced path, only `code`/`both` human approvals satisfy the gate — behavior-only blocks with `needs_code_review`. **Verified autonomy**: `policy.verifiedAutonomy` (OFF by default, parsed safe in `normalizeMergePolicy`) lets a server-validated `verifiedAttestation` substitute for the one human-code slot, up to `maxRisk`, gated by `allowSensitivePaths` + a configurable `floorGlobs` (`RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS` preset) and `agentId !== author` — `satisfiedBasis: "verified"`. |
| `verification.ts` | `recordVerification` (server re-binds run/agent/commit/no-self-verify; computes status from `checks`; upserts `verification_runs` on `(changeId, headCommit)`) + `loadVerifiedAttestation` (success row for the CURRENT head only → stale-after-push is automatic). The non-spoofable anchor for verified autonomy. |
| `changes.ts` | `ChangeService` — `evaluate()` (loads the head-pinned `verifiedAttestation`), `merge()` (wrapped in `withRepoLock`), `rollback()`, `maybeEnqueueAutoMerge()` (hands-off auto-merge of a verified+mergeable change; needs the injected `MergeQueue`). |
| `ci-runner.ts` | Runner callback — atomic claim, updates run, recomputes change `ciStatus` (newest run per pipeline votes), `reapStaleRuns` sweep for zombie runs, `reconcileDeployRuns` (boot + reaper cadence: a merge-group deploy run for the commit THIS API instance is running cannot have failed — severed-report phantom failures flip back to success). **CI concurrency groups**: a run may carry `ci_runs.concurrencyGroup`; a partial unique index (`ci_runs_running_group_uniq`, migration 0035) enforces AT MOST ONE `running` run per group, so the claim (pending→running) for a second run in a group fails with 23505 → treated as "group busy" (409), run stays pending. On terminal/reap, `dispatchNextInGroup` runs the NEWEST pending run in the group and collapses older pending ones to `skipped`. Merge→deploy runs (`changes.ts`) get group `merge:<repoId>` so a repo's deploys serialize newest-first instead of racing on the shared `~/clawhub` checkout. |
| `ci-yaml.ts` | CI YAML parser. `parsePipelineTrigger` → `{ kind: push\|merge\|schedule\|event, config }` derived from the `on:` field; persisted to `ci_pipelines.triggerKind` + `triggerConfig` at upsert (routes/ci.ts PUT). |
| `cron.ts` | Dependency-free 5-field cron matcher (UTC). `parseCron` (throws on malformed) + `cronDue(expr, last, now)` — true iff a tick fired in `(last, now]`. Supports `*`, `*/n`, `a-b`, `a,b,c`, exact; Vixie dom/dow OR semantics. |
| `ci-trigger.ts` | Shared enqueue path for schedule/event runs. `enqueueTriggeredRun` reuses the EXACT `ci.run.queued` payload the push path publishes (runner unchanged). Loop guard `shouldEnqueueTriggered` = depth cap (`MAX_TRIGGER_DEPTH=1`) + `(pipeline, commit, triggerEvent)` de-dup. Runs hold a per-run `runnerToken` like push/merge — no new privilege, never merge. |
| `pipeline-scheduler.ts` | `on: schedule` driver. `startPipelineScheduler` (setInterval ~60s, unref'd) → `runSchedulerTick`: finds `triggerKind='schedule'` pipelines, `cronDue` gate (UTC), compare-and-swap claim on `lastScheduledRunAt` (no double-fire across loops/processes), enqueues at default-branch HEAD. Started from `app.ts`. |
| `event-pipeline-trigger.ts` | `on: event` fan-out. `wireEventPipelineTriggers` subscribes to the EventBus; on each event, enqueues matching `triggerKind='event'` pipelines (`triggerConfig.event === e.type`) at default-branch HEAD, depth 1. Guard (a): `ci.*` events never fan out (`isCiOriginatedEvent`). Started from `app.ts`. |
| `token-revocation.ts` | DB-backed revocation checked on token-cache misses: agents must match `token_hash`, users must match `token_version` |
| `oauth-identity.ts` | OAuth account resolution: provider-ID first, verified email second (links), create last; rotates passwords on takeover-risk links |
| `secrets.ts` | tweetnacl seal/unseal with `CLAWHUB_SECRETS_KEY` |
| `events.ts` | `EventBus` (Redis Streams + in-process subscribers for SSE) |
| `webhooks-dispatch.ts` | HMAC-signs + POSTs to subscribed repo webhooks |
| `webhook-queue.ts` | Durable deliveries: event-wake for instant dispatch + 5s sweep for retries (CLAWHUB_WEBHOOK_POLL_MS) |
| `repo-resolver.ts` | `resolveNamespace`, `resolveRepo`, `mustResolveRepo` |
| `auth.ts` | JWT sign/verify, bcrypt passwords, sha256 token hashes (legacy bcrypt accepted), random tokens |
| `errors.ts` | `AppError` / `NotFoundError` / `AuthError` / `ForbiddenError` / `ConflictError` / `ValidationError` / `GitError` |

## Routes

All under `/api/v1/...` unless noted:

- `users` — register/login/me.
- `agents` — register (public; auto-claims when a valid user Bearer token rides along — no claim-token then), claim, me, rotate-token, `POST /:id/claim-token/rotate` (agent-only; mints a fresh time-boxed claim token — the agent token is sovereign), `POST /personal` (user-only; get-or-create the caller's one personal agent), `DELETE /:id` (user-only; **soft-delete/archive** one of the caller's claimed agents — sets `agents.archivedAt` + revokes the token via a non-matching `tokenHash` sentinel; `GET /` filters out archived. History the agent authored is preserved; not a hard delete. Migration 0034 adds `archived_at`). Claim tokens carry `claimTokenExpiresAt` (TTL `CLAWHUB_CLAIM_TOKEN_TTL_MS`, default 48h); expired tokens are rejected as not-found.
- **v2 agents-ux** (`routes/agent-identity.ts`, user-token only): `GET/POST /api/v1/llm-keys` + `DELETE /llm-keys/:id` (sealed BYO key vault, names only returned); `GET/POST/PATCH/DELETE /api/v1/access-roles` (defaults seeded on first GET); `POST /api/v1/agents/managed` (the one create flow — local returns the token once; deployed = per-repo standing rows sharing one identity, validate-everything-before-insert so failures leave no orphan). Registration gate: `POST /agents` without a user Bearer → 401 unless `CLAWHUB_ALLOW_UNCLAIMED_AGENT_REGISTER=1` (vitest sets it).
- `orgs` — create, list, add members.
- `repos` — list/get/patch, collaborators, transfer, **`DELETE /:ns/:repo`** (full irreversible delete — gated hard: HUMAN user token only (agents 403 `users_only`), repo ADMIN via `resolveRepoForAdmin`, and a typed `{confirm:"<ns>/<repo>"}` body; audited as `repo.deleted` with `repoId:null` so the trail survives the cascade; DB row delete cascades to all `repoId` rows, then `git.remove` clears disk).
- `changes` (mounted under `repos`) — list, get (+ live `behindBase`), diff (`mode=focused|full`), merge, **update-branch** (`POST .../changes/:id/update-branch` `{method:merge|rebase}` — brings the change current with its base via merge-base-in or rebase WITHOUT moving base, re-runs on:push CI; content conflicts → 409 "rebase locally"; `ChangeService.updateBranch` + `git.updateBranchInto` for LOCAL repos, the git-service `UpdateBranch`/`IsAncestor` ops via `git-client` for SHARDED repos — grpc transport falls back to a clear "use HTTP" error), rollback.
- `reviews` (mounted under `repos`) — list, submit.
- `issues` (mounted under `repos`) — CRUD + comments.
- `ci` — public `POST /api/v1/ci/runs/:id` (runner callback) + protected under `repos`: list/put pipelines, list runs. PUT derives `triggerKind` + `triggerConfig` from the YAML `on:` (`push`\|`merge`\|`schedule`\|`event`); rejects `on: schedule` with a missing/invalid `cron:` and `on: event` with no `event:`.
- `secrets` (mounted under `repos`) — names-only GET, PUT sealed value, DELETE.
- `releases` (mounted under `repos`) — list + create. `changeId` is OPTIONAL (`resolveReleaseTarget`): a release may be cut from a `tag` + optional `commit` (default: default-branch HEAD), so you can tag current main without a Change. When `changeId` IS given it must reference a merged change (old contract).
- `webhooks` (mounted under `repos`) — list/create/delete.
- `standing-agents` (mounted under `repos`) — CRUD + `POST /:id/run` (manual tick). Operator-gated (user with repo write). Attaches a BYO 24/7 agent: sealed agent token + LLM key, a trigger (manual|continuous|schedule|event), runs as a `ci_runs` row (`origin='agent'`). `services/standing-agents.ts` + `services/standing-agent-scheduler.ts`. See docs/standing-agents.md.
- `memory` (mounted under `repos`) — agent memory (FIT). Agent token: `GET /memory` (scoped union, ranked), `POST /memory` + `/memory/batch` (write, secret-scanned, idempotent on sourceRunId), `GET /memory/consolidation-candidates`, `DELETE /memory/:id` (invalidate), `POST/GET /memory/:id/edges` (graph edges). User token: `GET /memory` (repo view) + `PATCH /memory/:id` (pin/archive/review) + `GET /memory/graph` (nodes+edges). `services/memory.ts` + `services/memory-index.ts` (6-leg ranker incl. `graph`) + `services/memory-graph.ts` (edges + graph walk) + `services/memory-decay.ts`. See docs/memory.md.
- `social` — star/watch/follow + `GET /repos/:ns/:repo/social` (current-user state + counts).
- `events` — `GET /api/v1/events/stream` SSE. Auth via `?token=` or header (EventSource cannot send headers); mounted before the bare `/api/v1` routers whose `use("*")` auth would shadow it.
- `git-http` — `/:ns/:repo.git/*` (Smart HTTP).
- `code` (mounted under `repos`) — `tree` / `blob` / `readme` / `branches` read-only browsing. `tree` has TWO shapes: query-param (`/tree?ref=&path=`, the dashboard's api.ts) and GitHub-style path (`/tree/<ref>/<path...>`, incl. the root cases `/tree/main` and `/tree/main/`). The path form resolves slash-containing branch names greedily against the branch list (`splitRefPath`).
- `fleet` — `GET /api/v1/fleet` (the caller's PERSONAL fleet via `getMyFleet` — their own agents) and `GET /api/v1/fleet?org=<id>` (org fleet, members only). Same `OrgFleet` shape either way; backs the dashboard Fleet tab at any scale ("Solo = N=1").
- **Cross-repo agent aggregates** (`routes/agent-aggregates.ts`, user token): `GET /api/v1/standing-agents` (every standing agent across the caller's governed repos) and `GET /api/v1/memory` (agent memory across them). Each row carries its repo's `repoNs`/`repoName` so the hub routes per-row actions back to the repo-scoped endpoints. Mounted at specific prefixes (not bare `/api/v1`) so the `use("*")` auth can't shadow other routers; repo resolution mirrors `routes/repos.ts` GET / (user branch).
- `attention` — `GET /api/v1/attention` triage queue (users: claimed agents' + org repos; agents: own namespace). Reasons include `awaiting review` (no approvals yet) and `approved — ready to merge`.
- `oauth` — `/api/v1/oauth/{providers,:provider/start,:provider/callback}` consumer sign-in (GitHub + Google, env-configured; endpoints overridable for stub testing). Security routes are mounted under both `/api/v1/repos` (canonical) and `/api/v1` (legacy).

## Auth context

`ContextVariableMap.tokenPayload: TokenPayload` is either `{ kind: "user", userId, email, v? }` or `{ kind: "agent", agentId, name }`.

## Rate limit

Redis-backed (falls back to in-memory when Redis is down). Separate buckets: `/api/*` (CLAWHUB_API_RATE_LIMIT, 100/min/IP) and the git surface (CLAWHUB_GIT_RATE_LIMIT, 240/min/IP).

## Tests

`tests/*.test.ts` (vitest, globals enabled). Notable files:
- `trailer-parser.test.ts`, `trailer-focused.test.ts`
- `focus-parser.test.ts`
- `merge-policy.test.ts`
- `git-auth.test.ts` — verifies push auth: agent tokens (`agent-token` username) and user tokens (handle username) both authenticate and classify into the right `PushActor`
- `secrets.test.ts` — tweetnacl roundtrip
- `token-cache.test.ts` — Redis-backed JWT cache (degrades to local cache when Redis is down)
- `repo-lock.test.ts` — advisory-lock key stability + range
- `ref-rewriter.test.ts` — magic-ref parsing (`refs/for/<branch>`)
- `shard-map.test.ts` — HRW placement determinism + distribution
- `cron.test.ts` — 5-field cron matcher (`*/n`, ranges, lists, dom/dow OR, rollover, no double-fire same minute)
- `ci-yaml.test.ts` — `parsePipelineTrigger` (push/merge/schedule/event) + legacy `pipelineTrigger` mapping
- `pipeline-trigger.test.ts` — loop guard (depth cap + de-dup + `ci.*` exclusion), scheduler `cronDue` gating + CAS claim, event repo/type filtering (fake in-memory DB)

## Environment

- `DATABASE_URL` — Postgres (defaults to local `clawhub` user/db).
- `REDIS_URL` — Redis (default `redis://localhost:6379`).
- `JWT_SECRET` — JWT signing key.
- `CLAWHUB_SECRETS_KEY` — 32-byte base64 for libsodium sealing. **Writes reject if unset.**
- `GIT_REPOS_BASE_PATH` — on-disk bare-repo root (default `./data/repos`).
- `PORT` — HTTP port (default 3000).
