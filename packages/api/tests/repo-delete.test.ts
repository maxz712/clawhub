import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createRepoRoutes } from "../src/routes/repos.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-repo-delete";

// DELETE /:ns/:repo is a full, irreversible repo delete, so the gates matter.
// These pin the two security-critical boundaries that short-circuit BEFORE any
// DB work (so they need no real DB): unauthenticated → 401, and an agent token →
// 403 (humans only). The deeper gates (repo-admin via resolveRepoForAdmin, typed
// confirm) run after and are exercised against a real DB elsewhere / manually.
function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/repos", createRepoRoutes({} as DB, {} as GitService));
  app.onError(errorHandler);
  return app;
}

describe("DELETE /:ns/:repo gating", () => {
  it("401 without a token", async () => {
    const res = await buildApp().request("/api/v1/repos/ns/repo", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("403 for an AGENT token — humans only, refused before touching the DB", async () => {
    const token = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const res = await buildApp().request("/api/v1/repos/ns/repo", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ confirm: "ns/repo" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("users_only");
  });
});
