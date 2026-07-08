import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createPublicRoutes } from "../src/routes/public.js";

describe("GET /api/v1/public/version", () => {
  it("returns 200 with name and version", async () => {
    // The endpoint does not touch the database, so we can pass a dummy object.
    const publicApp = createPublicRoutes({} as any, "http://localhost");
    const app = new Hono();
    app.route("/api/v1/public", publicApp);

    const res = await app.request("/api/v1/public/version");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("name", "clawhub");
    expect(body).toHaveProperty("version");
  });
});
