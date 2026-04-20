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

export interface AppDeps {
  db: DB;
  git: GitService;
  events: EventBus;
  publicBaseUrl?: string;
}

export function buildApp(deps: AppDeps): Hono {
  const { db, git, events } = deps;
  const publicBaseUrl = deps.publicBaseUrl ?? process.env.CLAWHUB_PUBLIC_URL ?? "https://clawhub.dev";
  const changeRefs = new ChangeRefService(git);
  const changeSvc = new ChangeService(db, git, events);
  const lfsStore = new LfsStore(git.basePath);
  const pkgStore = new PackageStore(git.basePath);

  wireWebhookDispatch(db, events);

  // Mirror event publishing into metrics.
  events.onEvent(e => {
    metrics.inc("clawhub_events_published_total", { type: e.type });
    if (e.type === "change.merged") metrics.inc("clawhub_changes_merged_total", { method: String((e.payload as { method?: string } | undefined)?.method ?? "unknown") });
    if (e.type === "review.submitted") metrics.inc("clawhub_reviews_submitted_total", { verdict: String((e.payload as { verdict?: string } | undefined)?.verdict ?? "unknown") });
    if (e.type === "ci.completed") metrics.inc("clawhub_ci_runs_total", { status: String((e.payload as { status?: string } | undefined)?.status ?? "unknown") });
  });

  const app = new Hono();

  // Observability wraps everything.
  app.use("*", observability);
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-runner-token", "x-request-id", "traceparent", "x-package-metadata"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

  // Git Smart HTTP — mounts at root, owns its own auth.
  app.route("/", createGitHttpRoutes(db, git, changeRefs, events));
  app.route("/", createLfsRoutes(db, lfsStore, publicBaseUrl));

  // Public REST.
  app.use("/api/*", rateLimit);
  app.get("/api/v1/health", c => c.json({ ok: true }));
  app.get("/metrics", c => c.body(metrics.toPrometheus(), 200, { "content-type": "text/plain; version=0.0.4" }));
  app.route("/api/v1/users", createUserRoutes(db));
  app.route("/api/v1/agents", createAgentRoutes(db));
  app.route("/api/v1/public", createPublicRoutes(db, publicBaseUrl));
  app.route("/api/v1/playground", createPlaygroundRoutes());

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
  app.route("/api/v1/repos", createAuditRoutes(db));
  app.route("/api/v1/repos", pkgs.auth);
  app.route("/api/v1/repos", createForkRoutes(db, git));
  app.route("/api/v1", createSecurityRoutes(db));
  app.route("/api/v1/events", createEventRoutes(events));
  app.route("/api/v1/search", createSearchRoutes(db, git));
  app.route("/api/v1/notifications", createNotificationRoutes(db));
  app.route("/api/v1/agents", createQuotaRoutes(db));
  app.route("/api/v1/totp", createTotpRoutes(db));
  app.route("/api/v1", createSocialRoutes(db));

  app.onError(errorHandler);
  return app;
}
