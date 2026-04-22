import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentUsage } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import { getQuota, upsertQuota } from "../services/agent-scope.js";

export function createQuotaRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:id/quota", async c => {
    const p = c.get("tokenPayload");
    const agentId = c.req.param("id");
    // Agents can read their own; users can read for any agent (admin-ish, kept loose to match rest of the surface).
    if (p.kind === "agent" && p.agentId !== agentId) throw new AuthError("agent can only read own quota");
    const quota = await getQuota(db, agentId);
    return c.json({ quota });
  });

  app.patch("/:id/quota", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("only users can set quotas");
    const patch = await c.req.json().catch(() => ({}));
    const quota = await upsertQuota(db, c.req.param("id"), patch);
    if (!quota) throw new NotFoundError("agent");
    return c.json({ quota });
  });

  app.get("/:id/usage", async c => {
    const p = c.get("tokenPayload");
    const agentId = c.req.param("id");
    if (p.kind === "agent" && p.agentId !== agentId) throw new AuthError("agent can only read own usage");
    const rows = await db.select().from(agentUsage).where(eq(agentUsage.agentId, agentId)).orderBy(desc(agentUsage.window)).limit(200);
    return c.json({ usage: rows });
  });

  return app;
}
