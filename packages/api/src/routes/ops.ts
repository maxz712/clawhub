import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, killSwitches, orgAgentRegistry, orgMembers, repositories } from "../models/schema.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { blastRadius, disengage, engage } from "../services/kill-switch.js";
import { requireRepoWrite } from "../services/repo-access.js";

/**
 * Authorize a USER to govern (kill / inspect blast radius / bulk-rollback) a
 * target agent. These are tenant-crossing, destructive operations, so the
 * caller must be either:
 *   - the agent's owner — its claimed (associatedUserId) or service-account
 *     (serviceUserId) user; OR
 *   - a member of an org that ENROLLED the agent (org_agent_registry),
 *     mirroring the org-membership gate in routes/fleet.ts.
 * Throws NotFoundError when the agent does not exist (no existence leak),
 * ForbiddenError when the caller is unrelated to the agent.
 */
async function authorizeAgentGovernance(db: DB, agentId: string, userId: string): Promise<void> {
  const agent = (await db.select({
    id: agents.id,
    associatedUserId: agents.associatedUserId,
    serviceUserId: agents.serviceUserId,
  }).from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!agent) throw new NotFoundError("agent");

  // Owner of the agent (claimed or service user).
  if (agent.associatedUserId === userId || agent.serviceUserId === userId) return;

  // Member of an org that enrolled the agent. Join org_agent_registry (the
  // agent's enrolling orgs) against org_members (the caller's memberships).
  const enrolled = (await db.select({ orgId: orgAgentRegistry.orgId })
    .from(orgAgentRegistry)
    .innerJoin(orgMembers, and(
      eq(orgMembers.orgId, orgAgentRegistry.orgId),
      eq(orgMembers.userId, userId),
    ))
    .where(eq(orgAgentRegistry.agentId, agentId))
    .limit(1))[0];
  if (enrolled) return;

  throw new ForbiddenError("not authorized to govern this agent");
}

export function createOpsRoutes(db: DB, changeSvc: ChangeService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId);
    const row = (await db.select().from(killSwitches).where(eq(killSwitches.agentId, c.req.param("id"))).limit(1))[0];
    return c.json({ engaged: !!row, row: row ?? null });
  });

  app.post("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId);
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    await engage(db, c.req.param("id"), body.reason ?? null, p.userId);
    return c.json({ ok: true });
  });

  app.delete("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId);
    await disengage(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/agents/:id/blast-radius", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId);
    const hours = Number(c.req.query("hours") ?? 24);
    const report = await blastRadius(db, c.req.param("id"), hours);
    return c.json({ report });
  });

  app.post("/agents/:id/bulk-rollback", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId);
    const body = await c.req.json().catch(() => ({})) as { changeIds?: string[] };
    if (!Array.isArray(body.changeIds) || !body.changeIds.length) throw new ValidationError("changeIds required");
    const rows = await db.select().from(changes).where(and(eq(changes.openedByAgentId, c.req.param("id")), inArray(changes.id, body.changeIds)));
    const rolled: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const r of rows) {
      if (r.status !== "merged") { failed.push({ id: r.id, error: "not_merged" }); continue; }
      // Governing the agent is not sufficient to rewrite history in a repo the
      // caller cannot write to — a rollback is a write. Gate each change on the
      // caller's write access to that change's repo.
      const repo = (await db.select().from(repositories).where(eq(repositories.id, r.repoId)).limit(1))[0];
      if (!repo) { failed.push({ id: r.id, error: "repo_not_found" }); continue; }
      try { await requireRepoWrite(db, repo, p); }
      catch { failed.push({ id: r.id, error: "forbidden" }); continue; }
      try { await changeSvc.rollback(r.id, { kind: "human", id: p.userId }); rolled.push(r.id); }
      catch (e) { failed.push({ id: r.id, error: (e as Error).message }); }
    }
    return c.json({ rolled, failed });
  });

  return app;
}
