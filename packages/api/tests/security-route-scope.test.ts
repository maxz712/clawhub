import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSecurityAdminRoutes, createSecurityRoutes } from "../src/routes/security.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { DB } from "../src/models/db.js";

process.env.JWT_SECRET ??= "test-secret-security-scope";

// Regression: the platform-operator security routes (/advisories,
// /security/seed-defaults) used to be served by createSecurityRoutes, which
// installs `app.use("*", authMiddleware)`. Mounting that wildcard-auth router at
// the broad `/api/v1` prefix registered the auth middleware ahead of every
// PUBLIC route declared later in app.ts (Hono matches middleware in
// registration order), silently 401'ing /api/v1/public/status,
// /public/marketplace, the public billing surface, and /security/scan-diff.
//
// createSecurityAdminRoutes auths PER ROUTE instead, so mounting it at /api/v1
// adds no namespace-wide wildcard and public siblings stay reachable.
function buildRoot(): Hono {
  const root = new Hono();
  // The admin handlers only touch the db after auth passes, and these tests
  // never authenticate as a platform admin, so an empty stand-in is safe.
  root.route("/api/v1", createSecurityAdminRoutes({} as DB));
  // A public route mounted AFTER the security admin router — the exact ordering
  // that the old wildcard-auth mount broke.
  root.get("/api/v1/public/status", c => c.json({ ok: true, public: true }));
  root.onError(errorHandler);
  return root;
}

describe("security route scoping", () => {
  it("does not shadow public sibling routes mounted after it", async () => {
    const res = await buildRoot().request("/api/v1/public/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, public: true });
  });

  it("still requires auth on /advisories", async () => {
    const res = await buildRoot().request("/api/v1/advisories", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("still requires auth on /security/seed-defaults", async () => {
    const res = await buildRoot().request("/api/v1/security/seed-defaults", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("repo-scoped security router still guards its routes with auth", async () => {
    const root = new Hono();
    root.route("/api/v1/repos", createSecurityRoutes({} as DB));
    root.onError(errorHandler);
    const res = await root.request("/api/v1/repos/ns/repo/security/vulns");
    expect(res.status).toBe(401);
  });
});
