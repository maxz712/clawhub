import { Hono } from "hono";
import { cors } from "hono/cors";
import type { DB } from "./models/db.js";
import { GitService } from "./services/git.js";
import { ChangeRefService } from "./services/change-refs.js";
import { EventBus } from "./services/events.js";
import { ChangeService } from "./services/changes.js";
import { wireWebhookDispatch } from "./services/webhooks-dispatch.js";

import { rateLimit } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";

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

  wireWebhookDispatch(db, events);

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-runner-token"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

  // Git Smart HTTP — mounts at root, owns its own auth.
  app.route("/", createGitHttpRoutes(db, git, changeRefs, events));

  // Public REST.
  app.use("/api/*", rateLimit);
  app.get("/api/v1/health", c => c.json({ ok: true }));
  app.route("/api/v1/users", createUserRoutes(db));
  app.route("/api/v1/agents", createAgentRoutes(db));
  app.route("/api/v1/public", createPublicRoutes(db, publicBaseUrl));
  app.route("/api/v1/playground", createPlaygroundRoutes());

  const ci = createCiRoutes(db, events);
  app.route("/api/v1/ci", ci.public);

  // Protected REST.
  app.route("/api/v1/orgs", createOrgRoutes(db));
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
  app.route("/api/v1/events", createEventRoutes(events));
  app.route("/api/v1/search", createSearchRoutes(db, git));
  app.route("/api/v1/notifications", createNotificationRoutes(db));
  app.route("/api/v1/agents", createQuotaRoutes(db));
  app.route("/api/v1/totp", createTotpRoutes(db));
  app.route("/api/v1", createSocialRoutes(db));

  app.onError(errorHandler);
  return app;
}
