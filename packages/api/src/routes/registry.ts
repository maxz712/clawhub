import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { assertAgentEnrollable, enrollAgent, listOrgAgents, revokeAgent } from "../services/org-registry.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

export function createRegistryRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // The org agent registry is org-private governance: who may run as a granted
  // agent and at what trust tier. Without a membership check any authenticated
  // user could read, enroll, or revoke entries on ANOTHER org. Mirrors
  // fleet.ts's gate (orgMembers by (orgId, userId)). Members may read; admins
  // may enroll/revoke (a trust-tier grant is an admin act). Non-member → 404
  // (no org existence leak).
  async function requireMember(c: Context, orgId: string) {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
    if (!m) throw new NotFoundError("org");
    return { userId: p.userId, role: m.role };
  }

  app.get("/:orgId/registry", async c => {
    await requireMember(c, c.req.param("orgId"));
    const rows = await listOrgAgents(db, c.req.param("orgId"));
    return c.json({ agents: rows });
  });

  app.post("/:orgId/registry", async c => {
    const orgId = c.req.param("orgId");
    const { userId, role } = await requireMember(c, orgId);
    if (role !== "admin") throw new ForbiddenError("only org admins can enroll agents");
    const body = await c.req.json().catch(() => ({})) as { agentId?: string; trustTier?: "sandbox" | "standard" | "trusted" };
    if (!body.agentId) throw new ValidationError("agentId required");
    const tier = body.trustTier ?? "sandbox";
    // Enrollment confers governance authority (kill switch / blast radius / cost
    // caps). Requiring a real org↔agent relationship stops a self-appointed admin
    // from governing an arbitrary agent on the instance (#192). 404 for an absent
    // agent, 403 for an unrelated one.
    await assertAgentEnrollable(db, orgId, body.agentId);
    await enrollAgent(db, orgId, body.agentId, tier, userId);
    await getAuditLog(db).record({
      actorKind: "human", actorId: userId,
      action: "org.agent_enrolled", category: "admin",
      metadata: { orgId, agentId: body.agentId, trustTier: tier },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true }, 201);
  });

  app.delete("/:orgId/registry/:agentId", async c => {
    const orgId = c.req.param("orgId");
    const { userId, role } = await requireMember(c, orgId);
    if (role !== "admin") throw new ForbiddenError("only org admins can revoke agents");
    await revokeAgent(db, orgId, c.req.param("agentId"));
    await getAuditLog(db).record({
      actorKind: "human", actorId: userId,
      action: "org.agent_revoked", category: "admin",
      metadata: { orgId, agentId: c.req.param("agentId") },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  return app;
}
