import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAgentRoutes, createProtectedAgentRoutes } from "./routes/agents.js";
import { createRepoRoutes } from "./routes/repos.js";
import { createUserRoutes } from "./routes/users.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createEventRoutes } from "./routes/events.js";
import { createGitHttpRoutes } from "./routes/git-http.js";
import { createReviewRoutes } from "./routes/reviews.js";
import { createAttentionRoutes } from "./routes/attention.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { Database } from "./models/db.js";
import type { GitService } from "./services/git.js";
import type { ChangeService } from "./services/changes.js";
import type { EventBus } from "./services/events.js";
import type { ChangeRefService } from "./services/change-refs.js";

export function createApp(
  db: Database,
  gitService: GitService,
  changeService: ChangeService,
  eventBus: EventBus,
  changeRefService: ChangeRefService
) {
  const app = new Hono();

  app.onError(errorHandler);

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      exposeHeaders: [
        "X-RateLimit-Limit",
        "X-RateLimit-Remaining",
        "X-RateLimit-Reset",
      ],
      maxAge: 86400,
    })
  );

  // Git Smart HTTP routes — mounted BEFORE /api/v1 since they handle /:owner/:repo.git/...
  app.route("/", createGitHttpRoutes(db, gitService, eventBus, changeRefService));

  app.use("/api/*", rateLimitMiddleware);

  app.get("/health", (c) => c.json({ status: "ok" }));

  // Public routes (no auth required)
  app.route("/api/v1/agents", createAgentRoutes(db));
  app.route("/api/v1/users", createUserRoutes(db));

  // Protected routes
  const protectedApi = new Hono();
  protectedApi.use("*", authMiddleware);

  // Repos + changes + file tree/content + policies + permissions
  protectedApi.route("/repos", createRepoRoutes(db, gitService, changeService));

  // Reviews (mounted on same /repos path — handles /:owner/:repo/changes/:changeId/reviews)
  protectedApi.route("/repos", createReviewRoutes(db, changeService, eventBus));

  // Human attention feed + human-approve/reject actions
  const attentionRoutes = createAttentionRoutes(db, changeService, eventBus);
  protectedApi.route("/attention", attentionRoutes.feed);
  protectedApi.route("/repos", attentionRoutes.actions);

  // Dashboard (project health, agents, activity, stats)
  protectedApi.route("/dashboard", createDashboardRoutes(db));

  // Protected agent routes (me, profile, activity)
  protectedApi.route("/agents", createProtectedAgentRoutes(db));

  // SSE events
  protectedApi.route("/events", createEventRoutes(eventBus));

  app.route("/api/v1", protectedApi);

  return app;
}
