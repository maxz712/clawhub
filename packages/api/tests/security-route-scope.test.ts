import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSecurityAdminRoutes, createSecurityRoutes } from "../src/routes/security.js";
import { createSocialRoutes } from "../src/routes/social.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { DB } from "../src/models/db.js";

process.env.JWT_SECRET ??= "test-secret-security-scope";

// Regression for the new-user "public endpoints return 401" bug.
//
// Several routers (social, ops, agent-versions, quality, and the OLD security
// mount) install `app.use("*", authMiddleware)` and are mounted at the BROAD
// `/api/v1` prefix. Hono matches middleware in registration order, so such a
// wildcard 401s every PUBLIC route declared AFTER it — which is exactly how
// /api/v1/public/status, /public/marketplace, the public billing surface, and
// /security/scan-diff ended up auth-gated. The fix is twofold:
//   1) public routes must be registered BEFORE any broad wildcard-auth router;
//   2) routers that genuinely live at the bare /api/v1 prefix but need auth
//      (security admin) must auth PER ROUTE, not via `use("*")`.
// Both invariants are pinned below.

const publicHandler = (path: string) => {
  const r = new Hono();
  r.get(path, c => c.json({ ok: true, public: true }));
  return r;
};

describe("public route scoping vs broad wildcard-auth routers", () => {
  it("a public route registered BEFORE a broad wildcard-auth router stays reachable", async () => {
    const app = new Hono();
    app.route("/api/v1/public", publicHandler("/ping")); // before the wildcard
    app.route("/api/v1", createSocialRoutes({} as DB)); // installs use("*", authMiddleware)
    app.onError(errorHandler);
    const res = await app.request("/api/v1/public/ping");
    expect(res.status).toBe(200);
  });

  it("demonstrates the hazard: the SAME public route registered AFTER is 401'd", async () => {
    const app = new Hono();
    app.route("/api/v1", createSocialRoutes({} as DB)); // wildcard first
    app.route("/api/v1/public", publicHandler("/ping")); // shadowed
    app.onError(errorHandler);
    const res = await app.request("/api/v1/public/ping");
    expect(res.status).toBe(401);
  });

  it("the broad wildcard router still gates its OWN routes", async () => {
    const app = new Hono();
    app.route("/api/v1", createSocialRoutes({} as DB));
    app.onError(errorHandler);
    const res = await app.request("/api/v1/repos/ns/repo/social");
    expect(res.status).toBe(401);
  });
});

describe("security admin routes auth per-route (no namespace-wide wildcard)", () => {
  // createSecurityAdminRoutes is mounted at the bare /api/v1 prefix in app.ts.
  // Unlike the old createSecurityRoutes mount, it must NOT shadow public siblings.
  function buildRoot(): Hono {
    const root = new Hono();
    root.route("/api/v1", createSecurityAdminRoutes({} as DB));
    root.route("/api/v1/public", publicHandler("/status")); // sibling after it
    root.onError(errorHandler);
    return root;
  }

  it("does not shadow a public sibling mounted after it", async () => {
    const res = await buildRoot().request("/api/v1/public/status");
    expect(res.status).toBe(200);
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
