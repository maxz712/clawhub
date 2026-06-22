import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, killSwitches, orgAgentRegistry, orgMembers, repositories, standingAgents } from "../models/schema.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { blastRadius, disengage, engage } from "../services/kill-switch.js";
import { requireRepoWrite } from "../services/repo-access.js";

/**
 * Authorize a USER to govern (kill / inspect blast radius / bulk-rollback) a
 * target agent. These are tenant-crossing operations, so the caller must be:
 *   - the agent's owner — its claimed (associatedUserId) or service-account
 *     (serviceUserId) user; OR
 *   - a member of an org the agent ACTS ON — either it is enrolled in the org
 *     registry (org_agent_registry) OR it has a standing_agents deployment on a
 *     repo the org owns. The registry-only check previously left standing-attach
 *     and single-repo role-deploy agents ungovernable from the org fleet.
 *
 * `requireAdmin` (for DESTRUCTIVE actions — kill/release/bulk-rollback) demands
 * the org membership be ADMIN; read-only actions (status/blast-radius) accept any
 * member. The agent's OWNER always governs their own agent regardless.
 * Throws NotFoundError when the agent does not exist (no existence leak),
 * ForbiddenError when the caller is unrelated/under-privileged.
 */
async function authorizeAgentGovernance(db: DB, agentId: string, userId: string, opts: { requireAdmin?: boolean } = {}): Promise<void> {
  const agent = (await db.select({
    id: agents.id,
    associatedUserId: agents.associatedUserId,
    serviceUserId: agents.serviceUserId,
  }).from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!agent) throw new NotFoundError("agent");

  // Owner of the agent (claimed or service user) — always governs it.
  if (agent.associatedUserId === userId || agent.serviceUserId === userId) return;

  // Orgs this agent acts on: registry enrollment + standing deployments on the
  // org's repos.
  const enrollOrgs = await db.select({ orgId: orgAgentRegistry.orgId }).from(orgAgentRegistry).where(eq(orgAgentRegistry.agentId, agentId));
  const standingOrgs = await db.select({ orgId: repositories.namespaceId }).from(standingAgents)
    .innerJoin(repositories, eq(repositories.id, standingAgents.repoId))
    .where(and(eq(standingAgents.agentId, agentId), eq(repositories.namespaceType, "org")));
  const orgIds = [...new Set([...enrollOrgs.map(e => e.orgId), ...standingOrgs.map(s => s.orgId)])];
  if (orgIds.length) {
    const conds = [inArray(orgMembers.orgId, orgIds), eq(orgMembers.userId, userId)];
    if (opts.requireAdmin) conds.push(eq(orgMembers.role, "admin"));
    const m = (await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(and(...conds)).limit(1))[0];
    if (m) return;
    // A non-admin member of a governing org gets a precise 403 for a destructive action.
    if (opts.requireAdmin) {
      const member = (await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(and(inArray(orgMembers.orgId, orgIds), eq(orgMembers.userId, userId))).limit(1))[0];
      if (member) throw new ForbiddenError("org admin required to kill / roll back an org agent");
    }
  }

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
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId, { requireAdmin: true });
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    await engage(db, c.req.param("id"), body.reason ?? null, p.userId);
    return c.json({ ok: true });
  });

  app.delete("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId, { requireAdmin: true });
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
    await authorizeAgentGovernance(db, c.req.param("id"), p.userId, { requireAdmin: true });
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
