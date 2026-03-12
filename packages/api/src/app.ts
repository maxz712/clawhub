import { Hono } from "hono";
import { createAgentRoutes } from "./routes/agents.js";
import { createRepoRoutes } from "./routes/repos.js";
import { authMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import type { Database } from "./models/db.js";
import type { GitService } from "./services/git.js";

export function createApp(db: Database, gitService: GitService) {
  const app = new Hono();

  // Error handling
  app.onError(errorHandler);

  // Health check
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Agent registration does NOT require auth
  app.route("/api/v1/agents", createAgentRoutes(db));

  // Protected routes
  const protectedApi = new Hono();
  protectedApi.use("*", authMiddleware);
  protectedApi.route("/repos", createRepoRoutes(db, gitService));

  app.route("/api/v1", protectedApi);

  return app;
}
