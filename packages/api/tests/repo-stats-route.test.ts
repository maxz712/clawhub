import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createRepoRoutes } from "../src/routes/repos.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-repo-stats";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/repos", createRepoRoutes({} as DB, {} as GitService));
  app.onError(errorHandler);
  return app;
}

// GET /:ns/:repo/stats sits behind the same read-auth gate as every other repo
// route — pin the boundary that runs before any git work (mirrors repo-delete's
// gating tests). The underlying computation (GitService.repoStats) is covered
// end-to-end against a real bare repo in git-tree.test.ts.
describe("GET /:ns/:repo/stats gating", () => {
  it("401 without a token", async () => {
    const res = await buildApp().request("/api/v1/repos/ns/repo/stats");
    expect(res.status).toBe(401);
  });
});
