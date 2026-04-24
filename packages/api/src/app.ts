import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DB } from "./models/db.js";
import { GitService } from "./services/git.js";
import { ChangeRefService } from "./services/change-refs.js";
import { EventBus } from "./services/events.js";
import { ChangeService } from "./services/changes.js";
import { wireWebhookDispatch } from "./services/webhooks-dispatch.js";
import { LfsStore } from "./services/lfs.js";
import { PackageStore } from "./services/packages.js";
import { SandboxService } from "./services/sandbox.js";
import { WebhookDispatcher } from "./services/webhook-queue.js";
import { metrics } from "./services/metrics.js";

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
import { createCommentRoutes } from "./routes/comments.js";
import { createIssueRoutes } from "./routes/issues.js";
import { createMilestoneRoutes } from "./routes/milestones.js";
import { createIssueTemplateRoutes } from "./routes/issue-templates.js";
import { createCiRoutes } from "./routes/ci.js";
import { createArtifactRoutes } from "./routes/artifacts.js";
import { createSecretRoutes } from "./routes/secrets.js";
import { createReleaseRoutes } from "./routes/releases.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createEventRoutes } from "./routes/events.js";
import { createAuditRoutes } from "./routes/audit.js";
import { createSearchRoutes } from "./routes/search.js";
import { createNotificationRoutes } from "./routes/notifications.js";
import { createQuotaRoutes } from "./routes/quotas.js";
import { createTotpRoutes } from "./routes/totp.js";
import { createPlaygroundRoutes } from "./routes/playground.js";
import { createPublicRoutes } from "./routes/public.js";
import { createSocialRoutes } from "./routes/social.js";
import { createSsoRoutes } from "./routes/sso.js";
import { createLfsRoutes } from "./routes/lfs.js";
import { createPackageRoutes } from "./routes/packages.js";
import { createSecurityRoutes } from "./routes/security.js";
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
import { createChatopsRoutes } from "./routes/chatops.js";
import { createOpenApiRoutes } from "./routes/openapi.js";
import { createAdminRoutes } from "./routes/admin.js";
import { createGraphQLRoutes } from "./routes/graphql.js";
import { createOciRoutes } from "./routes/oci.js";
import { createAccountRoutes } from "./routes/account.js";
import { createStatusRoutes } from "./routes/status.js";
import { distributedRateLimit } from "./middleware/rate-limit-redis.js";
import { enforceJwtSecret } from "./services/auth-hardening.js";
import { buildMailerFromEnv, OutboxWorker } from "./services/mailer.js";
import { importFromGitLab } from "./services/gitlab-import.js";
import { importFromBitbucket } from "./services/bitbucket-import.js";
import { syncFromOsv } from "./services/osv-sync.js";
import { scanDiff as scanDiffForSecrets } from "./services/secret-scan.js";

export interface AppDeps {
  db: DB;
  git: GitService;
  events: EventBus;
  publicBaseUrl?: string;
}

export async function buildApp(deps: AppDeps): Promise<Hono> {
  const { db, git, events } = deps;
  // Refuse to boot in prod with default JWT secret.
  enforceJwtSecret();

  const publicBaseUrl = deps.publicBaseUrl ?? process.env.CLAWHUB_PUBLIC_URL ?? "https://clawhub.dev";
  const changeRefs = new ChangeRefService(git);
  const changeSvc = new ChangeService(db, git, events);
  const lfsStore = new LfsStore(git.basePath);
  const pkgStore = new PackageStore(git.basePath);
  const sandbox = new SandboxService(db);

  // Email outbox drainer. Runs every 10s; uses whichever mailer env picked.
  const mailer = buildMailerFromEnv();
  const outbox = new OutboxWorker(db, mailer);
  outbox.start();

  wireWebhookDispatch(db, events);
  // Durable webhook queue with retries + DLQ. Replaces the in-process dispatch
  // for new deliveries; the legacy sync dispatcher is kept only for SSE mirrors.
  const dispatcher = new WebhookDispatcher(db, events);
  dispatcher.start();

  // Metrics mirrors.
  events.onEvent(e => {
    metrics.inc("clawhub_events_published_total", { type: e.type });
    if (e.type === "change.merged") metrics.inc("clawhub_changes_merged_total", { method: String((e.payload as { method?: string } | undefined)?.method ?? "unknown") });
    if (e.type === "review.submitted") metrics.inc("clawhub_reviews_submitted_total", { verdict: String((e.payload as { verdict?: string } | undefined)?.verdict ?? "unknown") });
    if (e.type === "ci.completed") metrics.inc("clawhub_ci_runs_total", { status: String((e.payload as { status?: string } | undefined)?.status ?? "unknown") });
  });

  const app = new Hono();

  app.use("*", observability);
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-runner-token", "x-request-id", "traceparent", "x-package-metadata", "x-slack-request-timestamp", "x-slack-signature", "x-signature-timestamp", "x-signature-ed25519"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

  // Git Smart HTTP + LFS + OCI distribution spec at root.
  app.route("/", createGitHttpRoutes(db, git, changeRefs, events));
  app.route("/", createLfsRoutes(db, lfsStore, publicBaseUrl));
  app.route("/", createOciRoutes(db, pkgStore));

  // Public REST + ops endpoints.
  // Distributed rate-limit via Redis in front; per-IP in-memory as fallback.
  app.use("/api/*", distributedRateLimit());
  app.use("/api/*", rateLimit);
  app.get("/api/v1/health", c => c.json({ ok: true }));
  app.get("/metrics", c => c.body(metrics.toPrometheus(), 200, { "content-type": "text/plain; version=0.0.4" }));
  app.route("/api/v1/openapi", createOpenApiRoutes());
  app.route("/api/v1/users", createUserRoutes(db));
  app.route("/api/v1/agents", createAgentRoutes(db));
  app.route("/api/v1/public", createPublicRoutes(db, publicBaseUrl));
  app.route("/api/v1/playground", createPlaygroundRoutes());
  app.route("/api/v1/public/docs/repos", createDocsRoutes(db, git));
  app.route("/api/v1/chatops", createChatopsRoutes(db));

  const sso = createSsoRoutes(db);
  app.route("/api/v1/sso", sso.public);

  const ci = createCiRoutes(db, events);
  app.route("/api/v1/ci", ci.public);

  const pkgs = createPackageRoutes(db, pkgStore, publicBaseUrl);
  app.route("/api/v1/public/repos", pkgs.pub);

  // Protected REST.
  app.route("/api/v1/orgs", createOrgRoutes(db));
  app.route("/api/v1/orgs", sso.orgs);
  app.route("/api/v1/repos", createRepoRoutes(db));
  app.route("/api/v1/repos", createChangeRoutes(db, git, changeSvc));
  app.route("/api/v1/repos", createReviewRoutes(db, events));
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
  app.route("/api/v1/repos", createAuditRoutes(db));
  app.route("/api/v1/repos", pkgs.auth);
  app.route("/api/v1/repos", createForkRoutes(db, git));
  app.route("/api/v1/repos", createCodeSearchRoutes(db, git));
  app.route("/api/v1/repos", createSbomRoutes(db, git));
  app.route("/api/v1/repos", createPresenceRoutes(db));
  app.route("/api/v1/repos", createExternalSyncRoutes(db));

  const flagRoutes = createFlagRoutes(db);
  app.route("/api/v1/repos", flagRoutes.repo);
  app.route("/api/v1/flags", flagRoutes.publicEval);
  app.route("/api/v1/flags/global", flagRoutes.global);

  app.route("/api/v1", createSecurityRoutes(db));
  app.route("/api/v1/events", createEventRoutes(events));
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

  // Admin + ops + account (core).
  app.route("/api/v1/admin", createAdminRoutes(db));
  app.route("/api/v1/graphql", createGraphQLRoutes(db));
  app.route("/api/v1/account", createAccountRoutes(db, publicBaseUrl));
  const status = createStatusRoutes(db);
  app.route("/api/v1/public/status", status.pub);
  app.route("/api/v1/status", status.admin);

  // Edition + enterprise feature advertisement.
  // OSS returns `edition: "oss"` with `features: []`. Cloud returns the EE feature list
  // from @clawhub/api-ee after registerEeRoutes runs below.
  const edition = (process.env.CLAWHUB_EDITION ?? "oss").toLowerCase() === "cloud" ? "cloud" : "oss";
  let features: readonly string[] = [];
  if (edition === "cloud") {
    // Lazy-load @clawhub/api-ee. Keeps the OSS build from ever touching EE source.
    // The public build (OSS mirror) drops @clawhub/api-ee from the workspaces list, so this import
    // will fail at boot if someone tries to opt in to "cloud" on an OSS install — which is what we want.
    const ee = await import("@clawhub/api-ee");
    ee.registerEeRoutes(app, { db, publicBaseUrl });
    features = ee.EE_FEATURES;
  }
  app.get("/api/v1/edition", c => c.json({ edition, features }));

  // Admin-ish / ops endpoints that slot into the existing surface.
  app.post("/api/v1/migrate/gitlab", async c => {
    const p = c.get("tokenPayload");
    if (!p || p.kind !== "agent") return c.json({ error: "agents only" }, 401);
    const body = await c.req.json() as { gitlabToken: string; projectPath: string; targetRepoName?: string; includeIssues?: boolean; includeComments?: boolean; host?: string };
    const r = await importFromGitLab(db, git, {
      gitlabToken: body.gitlabToken, projectPath: body.projectPath,
      targetNamespace: p.name, namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      includeIssues: body.includeIssues, includeComments: body.includeComments, host: body.host,
      createdByKind: "agent", createdById: p.agentId,
    });
    return c.json(r);
  });
  app.post("/api/v1/migrate/bitbucket", async c => {
    const p = c.get("tokenPayload");
    if (!p || p.kind !== "agent") return c.json({ error: "agents only" }, 401);
    const body = await c.req.json() as { workspace: string; repoSlug: string; username: string; appPassword: string; targetRepoName?: string; includeIssues?: boolean };
    const r = await importFromBitbucket(db, git, {
      workspace: body.workspace, repoSlug: body.repoSlug,
      username: body.username, appPassword: body.appPassword,
      targetNamespace: p.name, namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      includeIssues: body.includeIssues,
      createdByKind: "agent", createdById: p.agentId,
    });
    return c.json(r);
  });
  app.post("/api/v1/advisories/osv-sync", async c => {
    const p = c.get("tokenPayload");
    if (!p || p.kind !== "user") return c.json({ error: "users only" }, 401);
    const body = await c.req.json() as { ecosystem: string; packageNames: string[]; baseUrl?: string };
    const r = await syncFromOsv(db, body);
    return c.json(r);
  });

  // Pre-receive style secret scan endpoint — agents call it against a diff and
  // abort locally if hits != []. The push pipeline can also invoke this inline.
  app.post("/api/v1/security/scan-diff", async c => {
    const body = await c.req.json().catch(() => ({})) as { diff?: string };
    if (!body.diff) return c.json({ error: "diff required" }, 400);
    const hits = scanDiffForSecrets(body.diff);
    return c.json({ hits });
  });

  app.onError(errorHandler);
  return app;
}
