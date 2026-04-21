import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { enrollAgent, listOrgAgents, revokeAgent } from "../services/org-registry.js";

export function createRegistryRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:orgId/registry", async c => {
    const rows = await listOrgAgents(db, c.req.param("orgId"));
    return c.json({ agents: rows });
  });

  app.post("/:orgId/registry", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { agentId?: string; trustTier?: "sandbox" | "standard" | "trusted" };
    if (!body.agentId) throw new ValidationError("agentId required");
    await enrollAgent(db, c.req.param("orgId"), body.agentId, body.trustTier ?? "sandbox", p.userId);
    return c.json({ ok: true }, 201);
  });

  app.delete("/:orgId/registry/:agentId", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await revokeAgent(db, c.req.param("orgId"), c.req.param("agentId"));
    return c.json({ ok: true });
  });

  return app;
}
