import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { TokenPayload } from "../services/auth.js";
import { agents, agentUsage } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { NotFoundError } from "../services/errors.js";
import { getQuota, upsertQuota } from "../services/agent-scope.js";

export function createQuotaRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // A quota/usage view is agent-scoped: only the agent itself, or the human who
  // owns/governs it (associated or service user), may read or set its limits.
  // Without this any user could read/mutate ANY agent's quotas. A non-owned (or
  // missing) agent resolves to 404 to avoid leaking which agent ids exist.
  async function requireAgentOwner(p: TokenPayload, agentId: string): Promise<void> {
    if (p.kind === "agent") {
      if (p.agentId !== agentId) throw new NotFoundError("agent");
      return;
    }
    const a = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
    if (a.associatedUserId !== p.userId && a.serviceUserId !== p.userId) throw new NotFoundError("agent");
  }

  app.get("/:id/quota", async c => {
    const p = c.get("tokenPayload");
    const agentId = c.req.param("id");
    // Only the agent itself or its owning/governing human may read its quota.
    await requireAgentOwner(p, agentId);
    const quota = await getQuota(db, agentId);
    return c.json({ quota });
  });

  app.patch("/:id/quota", async c => {
    const p = c.get("tokenPayload");
    const agentId = c.req.param("id");
    // Only the agent's owning/governing human (not any user) may set its limits.
    await requireAgentOwner(p, agentId);
    const patch = await c.req.json().catch(() => ({}));
    const quota = await upsertQuota(db, agentId, patch);
    if (!quota) throw new NotFoundError("agent");
    return c.json({ quota });
  });

  app.get("/:id/usage", async c => {
    const p = c.get("tokenPayload");
    const agentId = c.req.param("id");
    // Only the agent itself or its owning/governing human may read its usage.
    await requireAgentOwner(p, agentId);
    const rows = await db.select().from(agentUsage).where(eq(agentUsage.agentId, agentId)).orderBy(desc(agentUsage.window)).limit(200);
    return c.json({ usage: rows });
  });

  return app;
}
