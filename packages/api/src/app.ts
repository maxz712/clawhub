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
import { createIssueRoutes } from "./routes/issues.js";
import { createCiRoutes } from "./routes/ci.js";
import { createSecretRoutes } from "./routes/secrets.js";
import { createReleaseRoutes } from "./routes/releases.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createEventRoutes } from "./routes/events.js";

export interface AppDeps {
  db: DB;
  git: GitService;
  events: EventBus;
}

export function buildApp(deps: AppDeps): Hono {
  const { db, git, events } = deps;
  const changeRefs = new ChangeRefService(git);
  const changeSvc = new ChangeService(db, git, events);

  wireWebhookDispatch(db, events);

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowHeaders: ["authorization", "content-type"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] }));

  // Git Smart HTTP — mounts at root, owns its own auth.
  app.route("/", createGitHttpRoutes(db, git, changeRefs, events));

  // Public REST.
  app.use("/api/*", rateLimit);
  app.get("/api/v1/health", c => c.json({ ok: true }));
  app.route("/api/v1/users", createUserRoutes(db));
  app.route("/api/v1/agents", createAgentRoutes(db));

  const ci = createCiRoutes(db, events);
  app.route("/api/v1/ci", ci.public);

  // Protected REST.
  app.route("/api/v1/orgs", createOrgRoutes(db));
  app.route("/api/v1/repos", createRepoRoutes(db));
  app.route("/api/v1/repos", createChangeRoutes(db, git, changeSvc));
  app.route("/api/v1/repos", createReviewRoutes(db, events));
  app.route("/api/v1/repos", createIssueRoutes(db, events));
  app.route("/api/v1/repos", ci.repo);
  app.route("/api/v1/repos", createSecretRoutes(db));
  app.route("/api/v1/repos", createReleaseRoutes(db, events));
  app.route("/api/v1/repos", createWebhookRoutes(db));
  app.route("/api/v1/events", createEventRoutes(events));

  app.onError(errorHandler);
  return app;
}
