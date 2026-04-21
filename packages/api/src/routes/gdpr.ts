import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError } from "../services/errors.js";
import { getRequest, requestDeletion, requestExport } from "../services/gdpr.js";

export function createGdprRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/export", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const id = await requestExport(db, p.userId);
    return c.json({ requestId: id });
  });

  app.post("/delete", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const id = await requestDeletion(db, p.userId);
    return c.json({ requestId: id });
  });

  app.get("/requests/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const r = await getRequest(db, c.req.param("id"), p.userId);
    if (!r) return c.json({ error: "not_found" }, 404);
    return c.json({ request: r });
  });

  return app;
}
