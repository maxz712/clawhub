import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createLfsRoutes } from "../src/routes/lfs.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { DB } from "../src/models/db.js";
import type { LfsStore } from "../src/services/lfs.js";

// Regression: the LFS router is mounted at the app root. It once registered
// its agent-auth middleware with `use("*")`, which 401'd every sibling route
// in the app — including /api/v1/health. The middleware must apply only to
// LFS paths.

function buildRoot(): Hono {
  const root = new Hono();
  // The LFS handlers only touch db/store after auth passes, and these tests
  // never authenticate, so empty stand-ins are safe.
  root.route("/", createLfsRoutes({} as DB, {} as LfsStore, "http://localhost:3000"));
  root.get("/api/v1/health", c => c.json({ ok: true }));
  root.onError(errorHandler);
  return root;
}

describe("LFS route scoping", () => {
  it("does not shadow sibling routes mounted after it", async () => {
    const res = await buildRoot().request("/api/v1/health");
    expect(res.status).toBe(200);
  });

  it("still requires agent auth on LFS batch", async () => {
    const res = await buildRoot().request("/ns/repo.git/info/lfs/objects/batch", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("still requires agent auth on LFS object upload", async () => {
    const res = await buildRoot().request("/ns/repo.git/lfs/objects/abc123", { method: "PUT" });
    expect(res.status).toBe(401);
  });
});
