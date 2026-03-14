import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAgentRoutes, createProtectedAgentRoutes } from "./routes/agents.js";
import { createRepoRoutes } from "./routes/repos.js";
import { createUserRoutes } from "./routes/users.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createEventRoutes } from "./routes/events.js";
import { createFileRoutes, createTreeRoutes, createSingleFileRoute } from "./routes/files.js";
import { createGitHttpRoutes } from "./routes/git-http.js";
import { createReviewRoutes } from "./routes/reviews.js";
import { authMiddleware } from "./middleware/auth.js";
import { rateLimitMiddleware } from "./middleware/rateLimit.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { Database } from "./models/db.js";
import type { GitService } from "./services/git.js";
import type { ChangeService } from "./services/changes.js";
import type { EventBus } from "./services/events.js";

export function createApp(
  db: Database,
  gitService: GitService,
  changeService: ChangeService,
  eventBus: EventBus
) {
  const app = new Hono();

  // Error handling
  app.onError(errorHandler);

  // CORS
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

  // Git Smart HTTP routes — mounted BEFORE /api/v1 routes since git URLs
  // are at /:owner/:repo.git/... and handle their own auth
  app.route("/", createGitHttpRoutes(db, gitService, eventBus));

  // Rate limiting
  app.use("/api/*", rateLimitMiddleware);

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Agent registration does NOT require auth
  app.route("/api/v1/agents", createAgentRoutes(db));

  // User auth routes (register/login do not require auth, /me does)
  app.route("/api/v1/users", createUserRoutes(db));

  // Protected routes
  const protectedApi = new Hono();
  protectedApi.use("*", authMiddleware);
  protectedApi.route("/repos", createRepoRoutes(db, gitService, changeService));
  protectedApi.route("/repos", createReviewRoutes(db, changeService, eventBus));
  protectedApi.route("/dashboard", createDashboardRoutes(db));

  // Mount file routes under repos/:id/files (inside protected API)
  protectedApi.route("/repos/:id/files", createFileRoutes(db, gitService));

  // Mount tree and single-file routes
  protectedApi.route("/repos/:id/tree", createTreeRoutes(db, gitService));
  protectedApi.route("/repos/:id/file", createSingleFileRoute(db, gitService));

  // Protected agent routes
  protectedApi.route("/agents", createProtectedAgentRoutes(db));

  // SSE events (protected)
  protectedApi.route("/events", createEventRoutes(eventBus));

  app.route("/api/v1", protectedApi);

  return app;
}
