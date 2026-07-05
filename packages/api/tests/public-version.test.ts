import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createPublicRoutes } from "../src/routes/public.js";
import type { DB } from "../src/models/db.js";

// GET /api/v1/public/version is unauthenticated and never touches the DB, so a
// dummy db suffices to exercise the route (#28).
describe("GET /api/v1/public/version", () => {
  const app = new Hono();
  app.route("/api/v1/public", createPublicRoutes({} as unknown as DB, "http://localhost"));

  it("returns 200 with name and version", async () => {
    const res = await app.request("/api/v1/public/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("clawhub");
    expect(typeof body.version).toBe("string");
  });
});
