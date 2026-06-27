import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DB } from "./models/db.js";
import { GitService } from "./services/git.js";
import { ChangeRefService } from "./services/change-refs.js";
import { EventBus } from "./services/events.js";
import { ChangeService } from "./services/changes.js";
import { LfsStore } from "./services/lfs.js";
import { PackageStore } from "./services/packages.js";
import { SandboxService } from "./services/sandbox.js";
import { WebhookDispatcher } from "./services/webhook-queue.js";
import { metrics } from "./services/metrics.js";
import { log } from "./services/logger.js";
import { reapStaleRuns } from "./services/ci-runner.js";
import { startPipelineScheduler } from "./services/pipeline-scheduler.js";
import { wireEventPipelineTriggers } from "./services/event-pipeline-trigger.js";
import { startStandingAgentScheduler, wireStandingAgentEvents } from "./services/standing-agent-scheduler.js";
import { startMemoryDecaySweep } from "./services/memory-decay.js";
import { PushQueue, PushWorker } from "./services/push-queue.js";
import { MergeQueue, MergeWorker } from "./services/merge-queue.js";
import { runPostPushJob } from "./services/post-push-runner.js";
import { ShardMap } from "./services/shard-map.js";
import { GitClientPool } from "./services/git-client.js";
import { ShardHealthMonitor } from "./services/shard-health.js";
import { ShardWatcher } from "./services/shard-watcher.js";
import { createInternalRoutes } from "./routes/internal.js";
import { createCodeRoutes } from "./routes/code.js";
import { createAttentionRoutes } from "./routes/attention.js";
import { createOAuthRoutes } from "./routes/oauth.js";

import { rateLimit } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { observability } from "./middleware/observability.js";

import { createGitHttpRoutes } from "./routes/git-http.js";
import { createAgentRoutes } from "./routes/agents.js";
import { createUserRoutes } from "./routes/users.js";
import { createOrgRoutes } from "./routes/orgs.js";
import { createRepoRoutes } from "./routes/repos.js";
import { createChangeRoutes } from "./routes/changes.js";
import { createReviewRoutes } from "./routes/reviews.js";
import { createVerificationRoutes } from "./routes/verification.js";
import { createChangeEvidenceRoutes } from "./routes/change-evidence.js";
import { buildObjectStoreFromEnv } from "./services/object-store.js";
import { createCommentRoutes } from "./routes/comments.js";
import { createIssueRoutes } from "./routes/issues.js";
import { createMilestoneRoutes } from "./routes/milestones.js";
import { createIssueTemplateRoutes } from "./routes/issue-templates.js";
import { createCiRoutes } from "./routes/ci.js";
import { createArtifactRoutes } from "./routes/artifacts.js";
import { createSecretRoutes } from "./routes/secrets.js";
import { createReleaseRoutes } from "./routes/releases.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createStandingAgentRoutes } from "./routes/standing-agents.js";
import { createMemoryRoutes } from "./routes/memory.js";
import { createAgentRoleRoutes } from "./routes/agent-roles.js";
import { createFleetRoutes } from "./routes/fleet.js";
import { seedRoleTemplates, seedMarketplaceAgents } from "./services/agent-roles.js";
import { seedDefaultRules } from "./services/sast.js";
import { createEventRoutes } from "./routes/events.js";
import { createAuditRoutes } from "./routes/audit.js";
import { createSearchRoutes } from "./routes/search.js";
import { createNotificationRoutes } from "./routes/notifications.js";
import { createQuotaRoutes } from "./routes/quotas.js";
import { createTotpRoutes } from "./routes/totp.js";
import { createPlaygroundRoutes } from "./routes/playground.js";
import { createPublicRoutes } from "./routes/public.js";
import { createPublicRepoRoutes } from "./routes/public-repos.js";
import { createSocialRoutes } from "./routes/social.js";
import { createSsoRoutes } from "./routes/sso.js";
import { createLfsRoutes } from "./routes/lfs.js";
import { createPackageRoutes } from "./routes/packages.js";
import { createSecurityRoutes, createSecurityAdminRoutes } from "./routes/security.js";
import { createForkRoutes } from "./routes/forks.js";
import { createAttestationRoutes } from "./routes/attestations.js";
import { createSandboxRoutes } from "./routes/sandbox.js";
import { createCostRoutes } from "./routes/cost.js";
import { createOpsRoutes } from "./routes/ops.js";
import { createA2ARoutes } from "./routes/a2a.js";
import { createAgentVersionRoutes } from "./routes/agent-versions.js";
import { createQualityRoutes } from "./routes/quality.js";
import { createFlagRoutes } from "./routes/flags.js";
import { createWebhookAdminRoutes } from "./routes/webhook-admin.js";
import { createMigrationRoutes } from "./routes/migration.js";
import { createCodeSearchRoutes } from "./routes/code-search.js";
import { createSbomRoutes } from "./routes/sbom.js";
import { createPresenceRoutes } from "./routes/presence.js";
import { createExternalSyncRoutes } from "./routes/external-sync.js";
import { createDocsRoutes } from "./routes/docs.js";
import { createGdprRoutes } from "./routes/gdpr.js";
import { createRegistryRoutes } from "./routes/registry.js";
import { createChatopsRoutes } from "./routes/chatops.js";
import { createOpenApiRoutes } from "./routes/openapi.js";
import { createDiscoveryRoutes } from "./routes/discovery.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createGraphQLRoutes } from "./routes/graphql.js";
import { createScimRoutes } from "./routes/scim.js";
import { createOciRoutes } from "./routes/oci.js";
import { createAccountRoutes } from "./routes/account.js";
import { createMarketplaceRoutes } from "./routes/marketplace.js";
import { createBillingRoutes } from "./routes/billing.js";
import { createStatusRoutes } from "./routes/status.js";
import { distributedRateLimit } from "./middleware/rate-limit-redis.js";
import { enforceJwtSecret } from "./services/auth-hardening.js";
import { setRevocationChecker } from "./services/token-cache.js";
import { makeRevocationChecker } from "./services/token-revocation.js";
import { buildMailerFromEnv, OutboxWorker } from "./services/mailer.js";
import { buildSpMetadata } from "./services/saml-metadata.js";
import { syncFromOsv } from "./services/osv-sync.js";
import { scanDiff as scanDiffForSecrets } from "./services/secret-scan.js";

export interface AppDeps {
  db: DB;
  git: GitService;
  events: EventBus;
  publicBaseUrl?: string;
  /**
   * If true, the API process runs an in-process post-push worker. Default
   * behavior — convenient for dev and small deployments. Set to `false` in
   * production to run workers via `packages/api/src/worker.ts` instead, which
   * scales horizontally and isolates heavy work from request serving.
   */
  inProcessWorker?: boolean;
}

export function buildApp(deps: AppDeps): Hono {
  const { db, git, events } = deps;
  // Refuse to boot in prod with default JWT secret.
  enforceJwtSecret();
  // Every token verification also proves the token is still welcome:
  // agents against token_hash (rotate = revoke), users against
  // token_version (bump = end all sessions).
  setRevocationChecker(makeRevocationChecker(db));

  const publicBaseUrl = deps.publicBaseUrl ?? process.env.CLAWHUB_PUBLIC_URL ?? "https://useclawhub.com";
  const changeRefs = new ChangeRefService(git);
  const shardMap = new ShardMap(db);
  const gitClients = new GitClientPool();
  const shardHealth = new ShardHealthMonitor(db);
  shardHealth.start();
  const mergeQueue = new MergeQueue();
  const changeSvc = new ChangeService(db, git, events, mergeQueue);
  changeSvc.setShardRouting(shardMap, gitClients);
  // Hands-off auto-merge: when a verified + mergeable change's last gate lands
  // (a review, CI completion, or the verification report), enqueue its merge.
  // maybeEnqueueAutoMerge is a cheap no-op unless the repo opted into
  // autoMergeOnVerified AND the change carries a fresh verification attestation.
  events.onEvent(e => {
    if (!e.changeId) return;
    if (e.type === "review.submitted" || e.type === "ci.completed" || e.type === "change.verified") {
      void changeSvc.maybeEnqueueAutoMerge(e.changeId!);
    }
  });
  const lfsStore = new LfsStore(git.basePath);
  const pkgStore = new PackageStore(git.basePath);
  // Object store for Change evidence blobs (screenshots/logs). S3-backed when
  // CLAWHUB_OBJECT_STORE=s3, else on disk alongside the repos.
  const evidenceStore = buildObjectStoreFromEnv(process.env.CLAWHUB_EVIDENCE_PATH ?? `${git.basePath}/.evidence`);
  const sandbox = new SandboxService(db);

  // Phase 4 — failover watcher. Subscribes to Redis keyspace expirations on
  // `clawhub:shard-lease:*` and elects a new primary from caught-up replicas.
  const shardWatcher = new ShardWatcher(db, events);
  shardWatcher.start().catch(() => { /* logged inside */ });

  // Durable push pipeline. The push queue is consumed either by the in-process
  // worker below (default) or by `packages/api/src/worker.ts` in production.
  // `mergeQueue` is constructed here so the API can enqueue server-side merges;
  // its consumer lives in the worker process.
  const pushQueue = new PushQueue();
  const wantInProcess = deps.inProcessWorker ?? (process.env.CLAWHUB_DISABLE_INPROC_WORKER !== "1");
  if (wantInProcess) {
    const w = new PushWorker({ consumerName: `api-${process.pid}` });
    w.setHandler(job => runPostPushJob({ db, git, changeRefs, events }, job));
    w.start().catch(() => { /* logged inside */ });
    // Drain server-side merges in-process too — auto-merge (maybeEnqueueAutoMerge)
    // enqueues here. In prod with CLAWHUB_DISABLE_INPROC_WORKER=1 the standalone
    // worker.ts runs this MergeWorker instead.
    const mw = new MergeWorker({ changes: changeSvc });
    mw.start().catch(() => { /* logged inside */ });
  }

  // Email outbox drainer. Runs every 10s; uses whichever mailer env picked.
  const mailer = buildMailerFromEnv();
  const outbox = new OutboxWorker(db, mailer);
  outbox.start();

  // Durable webhook queue with retries + DLQ. This is the SOLE webhook path:
  // it enqueues each subscribed delivery to webhook_deliveries, HMAC-signs, and
  // retries with backoff. The legacy in-process wireWebhookDispatch was removed
  // — it fired a SECOND, unrecorded POST per event to every webhook URL (a
  // duplicate-delivery bug), with no delivery record, retry, or DLQ.
  const dispatcher = new WebhookDispatcher(db, events);
  dispatcher.start();

  // Stale CI run sweep: runs a dead runner abandoned, or that no runner ever
  // claimed, get marked failed instead of hanging in the UI forever.
  const reapTimer = setInterval(() => {
    reapStaleRuns(db, events).then(n => { if (n > 0) log("warn", "ci_runs_reaped", { count: n }); }).catch(() => { /* next sweep retries */ });
  }, 60_000);
  reapTimer.unref();

  // Scheduled CI pipelines (`on: schedule`): a ~60s loop fires due cron ticks at
  // the repo default-branch HEAD, reusing the push path's ci.run.queued payload.
  // The interval is unref'd (like the reaper), and double-fire across overlapping
  // ticks / multiple API processes is prevented by a compare-and-swap on
  // lastScheduledRunAt inside runSchedulerTick. See services/pipeline-scheduler.ts.
  startPipelineScheduler(db, events);

  // Event-triggered CI pipelines (`on: event`): fan out matching runs when an
  // event fires. The loop guard (ci.* events excluded + depth cap + de-dup) lives
  // in services/event-pipeline-trigger.ts and services/ci-trigger.ts.
  wireEventPipelineTriggers(db, events);

  // Standing agents (BYO autonomous agents): a ~60s loop fires continuous +
  // schedule ticks, and an event subscription fires event-triggered ones. Each
  // dispatch re-checks the kill switch, cost budget, in-flight, and rate cap.
  // ClawHub never runs the model — a tick dispatches a ci_run(origin='agent')
  // that the runner executes as the user's container. See services/standing-agents.ts.
  startStandingAgentScheduler(db, events);
  wireStandingAgentEvents(db, events);

  // Agent memory decay: an hourly deterministic sweep archives cold, unused
  // memories and hard-prunes long-archived / superseded / expired ones. Usage
  // refreshes recency, so used memories survive. See services/memory-decay.ts.
  startMemoryDecaySweep(db);

  // Seed the curated Agent Role templates (worker, security-reviewer, …) + the
  // marketplace catalog from them. Idempotent; safe to run on every boot.
  seedRoleTemplates(db)
    .then(() => seedMarketplaceAgents(db))
    .catch(e => log("warn", "role_templates_seed_failed", { err: (e as Error).message }));

  // Seed the default SAST rules GLOBALLY (repoId null → they match every repo's
  // scan via or(isNull(repoId), …)). Without this the per-repo Security tab is
  // dead on a fresh account — the rules existed only behind a manual click on the
  // global /security page. Idempotent (onConflictDoNothing).
  seedDefaultRules(db).catch(e => log("warn", "sast_rules_seed_failed", { err: (e as Error).message }));

  // Metrics mirrors.
  events.onEvent(e => {
    metrics.inc("clawhub_events_published_total", { type: e.type });
    if (e.type === "change.merged") metrics.inc("clawhub_changes_merged_total", { method: String((e.payload as { method?: string } | undefined)?.method ?? "unknown") });
    if (e.type === "review.submitted") metrics.inc("clawhub_reviews_submitted_total", { verdict: String((e.payload as { verdict?: string } | undefined)?.verdict ?? "unknown") });
    if (e.type === "ci.completed") metrics.inc("clawhub_ci_runs_total", { status: String((e.payload as { status?: string } | undefined)?.status ?? "unknown") });
  });

  const app = new Hono();

  app.use("*", observability);

  // Header-only security headers on every response. Kept conservative — no CSP
  // (would risk breaking the JSON/git/OCI/LFS surface); just hardening headers.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  });

  // CORS origin is "*" by default (auth is Bearer-only, no cookies). Operators
  // can lock it down with a CLAWHUB_CORS_ORIGINS allowlist (comma-separated).
  const corsOriginsEnv = (process.env.CLAWHUB_CORS_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const corsOrigin = corsOriginsEnv.length > 0 ? corsOriginsEnv : "*";
  app.use("*", cors({ origin: corsOrigin, allowHeaders: ["authorization", "content-type", "x-runner-token", "x-request-id", "traceparent", "x-package-metadata", "x-slack-request-timestamp", "x-slack-signature", "x-signature-timestamp", "x-signature-ed25519"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

  // Rate-limit the git surface (Smart HTTP + LFS live outside /api/). A push
  // is ~3 requests, so the default still allows ~80 pushes/min per IP; tune
  // with CLAWHUB_GIT_RATE_LIMIT. Registered before the git routes so it runs.
  app.use("*", distributedRateLimit({
    match: /^\/[^/]+\/[^/]+\.git(\/|$)/,
    max: Number(process.env.CLAWHUB_GIT_RATE_LIMIT ?? 240),
    keyPrefix: "git",
  }));

  // Git Smart HTTP + LFS + OCI distribution spec at root. LFS must mount
  // before git-http: its routes live under /:ns/:repo.git/ and would otherwise
  // be swallowed by git-http's catch-all.
  app.route("/", createLfsRoutes(db, lfsStore, publicBaseUrl));
  app.route("/", createGitHttpRoutes({
    db, git, changeRefs, events, queue: pushQueue,
    shardMap, gitClients, shardHealth,
  }));
  // Internal HMAC endpoints (pre-receive hook calls /api/v1/internal/ref-log).
  app.route("/api/v1/internal", createInternalRoutes(db));
  app.route("/", createOciRoutes(db, pkgStore));
  // Agent discovery (public, unauthenticated): /skill.md, /llms.txt,
  // /.well-known/clawhub — so an agent pointed at just the host can bootstrap.
  app.route("/", createDiscoveryRoutes());

  // Public REST + ops endpoints.
  // Distributed rate-limit via Redis in front; per-IP in-memory as fallback.
  app.use("/api/*", distributedRateLimit({ max: Number(process.env.CLAWHUB_API_RATE_LIMIT ?? 100) }));
  app.use("/api/*", rateLimit);
  // Version + uptime let deploy scripts and load balancers verify which build
  // is actually serving, not just that something answers.
  const bootedAt = Date.now();
  app.get("/api/v1/health", c => c.json({
    ok: true,
    version: process.env.CLAWHUB_VERSION ?? process.env.npm_package_version ?? "dev",
    uptimeSec: Math.floor((Date.now() - bootedAt) / 1000),
    // Discovery pointers so an agent that pings health can find the bootstrap.
    skill: "/skill.md",
    discovery: "/.well-known/clawhub",
  }));
  app.get("/metrics", c => c.body(metrics.toPrometheus(), 200, { "content-type": "text/plain; version=0.0.4" }));
  app.route("/api/v1/openapi", createOpenApiRoutes());
  app.route("/api/v1/users", createUserRoutes(db));
  app.route("/api/v1/oauth", createOAuthRoutes(db, publicBaseUrl));
  // SSE stream authenticates via ?token= (EventSource cannot send headers).
  // Must mount before the bare /api/v1 routers below — their header-only
  // `use("*", authMiddleware)` would otherwise 401 the stream first.
  app.route("/api/v1/events", createEventRoutes(db, events));
  app.route("/api/v1/agents", createAgentRoutes(db));
  app.route("/api/v1/public", createPublicRoutes(db, publicBaseUrl));
  app.route("/api/v1/playground", createPlaygroundRoutes());
  app.route("/api/v1/public/docs/repos", createDocsRoutes(db, git));
  app.route("/api/v1/chatops", createChatopsRoutes(db));

  const sso = createSsoRoutes(db);
  app.route("/api/v1/sso", sso.public);

  const ci = createCiRoutes(db, events, publicBaseUrl);
  app.route("/api/v1/ci", ci.public);

  const pkgs = createPackageRoutes(db, pkgStore, publicBaseUrl);
  app.route("/api/v1/public/repos", pkgs.pub);
  // Anonymous read-only repo browse (logged-out public surface). Mounted after
  // public.ts (its static og.svg routes win) and pkgs.pub; serves public repos
  // to anyone and 404s private repos for non-members.
  app.route("/api/v1/public/repos", createPublicRepoRoutes(db, git));

  // Genuinely-public endpoints (NO auth) — status page, public marketplace,
  // public billing/pricing, SAML SP metadata, pre-push secret scan. These MUST
  // be registered BEFORE the broad `app.route("/api/v1", ...)` routers further
  // down: several of those (security-admin aside — social, ops, agent-versions,
  // quality) install `app.use("*", authMiddleware)`, which Hono registers as a
  // wildcard over ALL of /api/v1 and would 401 every public route declared after
  // them. Only the PUBLIC halves come up here; the auth-only halves stay below
  // with the protected surface (the consts are reused there).
  const marketplace = createMarketplaceRoutes(db);
  app.route("/api/v1/public/marketplace", marketplace.pub);
  const billing = createBillingRoutes(db, publicBaseUrl);
  app.route("/api/v1/billing", billing.pub);
  const status = createStatusRoutes(db);
  app.route("/api/v1/public/status", status.pub);

  // SAML SP metadata for any org, helpful when configuring an IdP. Public.
  app.get("/api/v1/sso/saml/metadata", c => {
    const xml = buildSpMetadata({
      entityId: c.req.query("entityId") ?? `${publicBaseUrl}/saml`,
      acsUrl: `${publicBaseUrl}/api/v1/sso/saml/acs`,
    });
    return c.body(xml, 200, { "content-type": "application/samlmetadata+xml" });
  });

  // Pre-receive style secret scan — agents call it against a diff and abort
  // locally if hits != []. Public (no token): it only runs regex over the
  // submitted text, reads nothing else, and the push pipeline invokes it inline.
  app.post("/api/v1/security/scan-diff", async c => {
    const body = await c.req.json().catch(() => ({})) as { diff?: string };
    if (!body.diff) return c.json({ error: "diff required" }, 400);
    const hits = scanDiffForSecrets(body.diff);
    return c.json({ hits });
  });

  // Protected REST.
  app.route("/api/v1/orgs", createOrgRoutes(db));
  app.route("/api/v1/orgs", sso.orgs);
  app.route("/api/v1/orgs", createRegistryRoutes(db));
  app.route("/api/v1/repos", createRepoRoutes(db, git));
  app.route("/api/v1/repos", createChangeRoutes(db, git, changeSvc));
  app.route("/api/v1/repos", createReviewRoutes(db, events));
  app.route("/api/v1/repos", createVerificationRoutes(db, events));
  app.route("/api/v1/repos", createChangeEvidenceRoutes(db, evidenceStore, publicBaseUrl));
  app.route("/api/v1/repos", createCommentRoutes(db, events));
  app.route("/api/v1/repos", createIssueRoutes(db, events));
  app.route("/api/v1/repos", createMilestoneRoutes(db));
  app.route("/api/v1/repos", createIssueTemplateRoutes(db));
  app.route("/api/v1/repos", ci.repo);
  app.route("/api/v1/repos", createArtifactRoutes(db));
  app.route("/api/v1/repos", createSecretRoutes(db));
  app.route("/api/v1/repos", createReleaseRoutes(db, events));
  app.route("/api/v1/repos", createWebhookRoutes(db));
  app.route("/api/v1/repos", createWebhookAdminRoutes(db));
  app.route("/api/v1/repos", createStandingAgentRoutes(db, events));
  app.route("/api/v1/repos", createMemoryRoutes(db));
  app.route("/api/v1/roles", createAgentRoleRoutes(db));
  app.route("/api/v1/fleet", createFleetRoutes(db));
  app.route("/api/v1/repos", createAuditRoutes(db));
  app.route("/api/v1/repos", pkgs.auth);
  app.route("/api/v1/repos", createForkRoutes(db, git, events));
  app.route("/api/v1/repos", createCodeRoutes(db, git));
  app.route("/api/v1/repos", createCodeSearchRoutes(db, git));
  app.route("/api/v1/repos", createSbomRoutes(db, git));
  app.route("/api/v1/repos", createPresenceRoutes(db));
  app.route("/api/v1/repos", createExternalSyncRoutes(db));

  const flagRoutes = createFlagRoutes(db);
  app.route("/api/v1/repos", flagRoutes.repo);
  app.route("/api/v1/flags", flagRoutes.publicEval);
  app.route("/api/v1/flags/global", flagRoutes.global);

  // Repo-scoped mount matches the rest of the repo surface (and the dashboard
  // client). The two platform-operator routes that live at the bare /api/v1
  // prefix (/advisories, /security/seed-defaults) are mounted via a SEPARATE
  // router that auths per-route — mounting the wildcard-auth createSecurityRoutes
  // at /api/v1 previously 401'd every public route declared after it (status,
  // marketplace, billing, scan-diff). See routes/security.ts.
  app.route("/api/v1/repos", createSecurityRoutes(db));
  app.route("/api/v1", createSecurityAdminRoutes(db));
  app.route("/api/v1/attention", createAttentionRoutes(db));
  app.route("/api/v1/search", createSearchRoutes(db, git));
  app.route("/api/v1/notifications", createNotificationRoutes(db));
  app.route("/api/v1/agents", createQuotaRoutes(db));
  app.route("/api/v1/totp", createTotpRoutes(db));
  app.route("/api/v1", createSocialRoutes(db));
  app.route("/api/v1/attestations", createAttestationRoutes(db));
  app.route("/api/v1/sandbox", createSandboxRoutes(db, sandbox));
  app.route("/api/v1/cost", createCostRoutes(db));
  app.route("/api/v1", createOpsRoutes(db, changeSvc));
  app.route("/api/v1/agents", createA2ARoutes(db));
  app.route("/api/v1", createAgentVersionRoutes(db));
  app.route("/api/v1", createQualityRoutes(db));
  app.route("/api/v1/migrate", createMigrationRoutes(db, git));
  app.route("/api/v1/gdpr", createGdprRoutes(db));

  // Tier B/C/D additions.
  app.route("/api/v1/admin", createAdminRoutes(db, { events, gitClients }));
  app.route("/api/v1/graphql", createGraphQLRoutes(db));
  app.route("/api/v1/scim/v2", createScimRoutes(db));
  app.route("/api/v1/account", createAccountRoutes(db, publicBaseUrl));
  // Auth-only halves of the routers whose public halves are mounted up in the
  // public block (marketplace/billing/status) — the consts are declared there.
  app.route("/api/v1/marketplace", marketplace.auth);
  app.route("/api/v1/billing", billing.auth);
  app.route("/api/v1/status", status.admin);

  // Admin-ish / ops endpoints that slot into the existing surface.
  // GitHub/GitLab/Bitbucket import live in createMigrationRoutes (routes/migration.ts) —
  // mounted above at /api/v1/migrate; they support targetNamespace resolution + audit.
  app.post("/api/v1/advisories/osv-sync", async c => {
    const p = c.get("tokenPayload");
    if (!p || p.kind !== "user") return c.json({ error: "users only" }, 401);
    const body = await c.req.json() as { ecosystem: string; packageNames: string[]; baseUrl?: string };
    const r = await syncFromOsv(db, body);
    return c.json(r);
  });

  app.onError(errorHandler);
  return app;
}
