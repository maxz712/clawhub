import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { computeAgentQuality, getQuality, recomputeAll } from "../services/agent-quality.js";

export function createQualityRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/agents/:id/quality", async c => {
    const cached = await getQuality(db, c.req.param("id"));
    if (cached) return c.json({ quality: cached, cached: true });
    const fresh = await computeAgentQuality(db, c.req.param("id"));
    return c.json({ quality: fresh, cached: false });
  });

  app.post("/agents/:id/quality/recompute", async c => {
    const fresh = await computeAgentQuality(db, c.req.param("id"));
    return c.json({ quality: fresh });
  });

  app.post("/quality/recompute-all", async c => {
    const n = await recomputeAll(db);
    return c.json({ recomputed: n });
  });

  return app;
}
