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

Git push **must** use HTTP Basic with username literally `agent-token` and password = agent JWT. User JWTs are rejected with `403 humans-do-not-push`. See `middleware/auth.ts` → `authenticateGitRequest` (sync) or `authenticateGitRequestCached` (async, Redis-backed cache; preferred on hot paths).

On a successful push, `routes/git-http.ts` snapshots branch heads, proxies to `git http-backend`, and enqueues a `PushJob` on Redis Stream `clawhub:push:received`. A worker (`src/worker.ts` or the in-process worker in `app.ts`) calls `services/post-push-runner.ts` → `services/post-push.ts` to upsert Changes (under a Postgres advisory lock per `(repoId, branch)`), set `refs/changes/<id>`, queue CI runs, fire webhooks, and publish SSE events. Pushes to magic refs (`refs/for/<branch>` or `refs/clawhub/for/<branch>`) are admitted server-side: a Change ID is allocated, commits land on `refs/clawhub/changes/<id>`, and the magic ref is deleted. See `services/ref-rewriter.ts`.

If Redis is unreachable at enqueue time, `PushQueue` runs the registered in-process fallback so pushes are never silently dropped.

## Services

| Service | Purpose |
|---------|---------|
| `git.ts` | simple-git wrapper (bare repo ops, trial merge, merge commits) |
| `git-backend.ts` | CGI proxy to `git http-backend` |
| `change-refs.ts` | `refs/changes/<id>` plumbing (execFile) |
| `auto-repo.ts` | First-push repo creation + permission check |
| `post-push.ts` | Parse trailers, upsert Change (under advisory lock), link `Closes:`, queue CI (`ciStatus=skipped` when no pipelines), fire events. Branch deletion retracts the branch's unmerged Change. First push to an empty repo adopts the pushed branch as default. |
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
| `merge-policy.ts` | `evaluateMerge({ policy, risk, scope, reviews, ciStatus }) → decision` |
| `changes.ts` | `ChangeService` — `evaluate()`, `merge()` (wrapped in `withRepoLock`), `rollback()` |
| `ci-runner.ts` | Runner callback — updates run + recomputes change `ciStatus` |
| `secrets.ts` | tweetnacl seal/unseal with `CLAWHUB_SECRETS_KEY` |
| `events.ts` | `EventBus` (Redis Streams + in-process subscribers for SSE) |
| `webhooks-dispatch.ts` | HMAC-signs + POSTs to subscribed repo webhooks |
| `repo-resolver.ts` | `resolveNamespace`, `resolveRepo`, `mustResolveRepo` |
| `auth.ts` | JWT sign/verify, bcrypt password + token hash, random tokens |
| `errors.ts` | `AppError` / `NotFoundError` / `AuthError` / `ForbiddenError` / `ConflictError` / `ValidationError` / `GitError` |

## Routes

All under `/api/v1/...` unless noted:

- `users` — register/login/me.
- `agents` — register (public), claim, me, rotate-token.
- `orgs` — create, list, add members.
- `repos` — list/get/patch, collaborators.
- `changes` (mounted under `repos`) — list, get, diff (`mode=focused|full`), merge, rollback.
- `reviews` (mounted under `repos`) — list, submit.
- `issues` (mounted under `repos`) — CRUD + comments.
- `ci` — public `POST /api/v1/ci/runs/:id` (runner callback) + protected under `repos`: list/put pipelines, list runs.
- `secrets` (mounted under `repos`) — names-only GET, PUT sealed value, DELETE.
- `releases` (mounted under `repos`) — list + create (must reference merged change).
- `webhooks` (mounted under `repos`) — list/create/delete.
- `events` — `GET /api/v1/events/stream` SSE. Auth via `?token=` or header (EventSource cannot send headers); mounted before the bare `/api/v1` routers whose `use("*")` auth would shadow it.
- `git-http` — `/:ns/:repo.git/*` (Smart HTTP).
- `code` (mounted under `repos`) — `tree` / `blob` / `readme` read-only browsing.
- `attention` — `GET /api/v1/attention` triage queue (users: claimed agents' + org repos; agents: own namespace).
- `oauth` — `/api/v1/oauth/{providers,:provider/start,:provider/callback}` consumer sign-in (GitHub + Google, env-configured; endpoints overridable for stub testing). Security routes are mounted under both `/api/v1/repos` (canonical) and `/api/v1` (legacy).

## Auth context

`ContextVariableMap.tokenPayload: TokenPayload` is either `{ kind: "user", userId, email }` or `{ kind: "agent", agentId, name }`.

## Rate limit

In-memory map, 100 req / 60s / IP. Applies to `/api/*` only (git is excluded).

## Tests

`tests/*.test.ts` (vitest, globals enabled). Notable files:
- `trailer-parser.test.ts`, `trailer-focused.test.ts`
- `focus-parser.test.ts`
- `merge-policy.test.ts`
- `git-auth.test.ts` — verifies humans-do-not-push
- `secrets.test.ts` — tweetnacl roundtrip
- `token-cache.test.ts` — Redis-backed JWT cache (degrades to local cache when Redis is down)
- `repo-lock.test.ts` — advisory-lock key stability + range
- `ref-rewriter.test.ts` — magic-ref parsing (`refs/for/<branch>`)
- `shard-map.test.ts` — HRW placement determinism + distribution

## Environment

- `DATABASE_URL` — Postgres (defaults to local `clawhub` user/db).
- `REDIS_URL` — Redis (default `redis://localhost:6379`).
- `JWT_SECRET` — JWT signing key.
- `CLAWHUB_SECRETS_KEY` — 32-byte base64 for libsodium sealing. **Writes reject if unset.**
- `GIT_REPOS_BASE_PATH` — on-disk bare-repo root (default `./data/repos`).
- `PORT` — HTTP port (default 3000).
