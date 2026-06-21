import { Hono } from "hono";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, auditEvents, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForWrite } from "../services/repo-access.js";

export function createAuditRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/audit", async c => {
    // The audit log records actor IPs/user-agents and sensitive governance
    // actions, so it must NOT be world-readable on a public repo. Gate on
    // write+ (collaborators / owners / org members) rather than read.
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const category = c.req.query("category");
    const action = c.req.query("action");
    const before = c.req.query("before");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

    const filters = [eq(auditEvents.repoId, repo.id)];
    if (category) filters.push(eq(auditEvents.category, category));
    if (action) filters.push(eq(auditEvents.action, action));
    if (before) filters.push(lt(auditEvents.createdAt, new Date(before)));

    const rows = await db.select().from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);

    // Resolve actorId → display name so the UI doesn't render bare UUIDs. Human
    // actors resolve against users, agent actors against agents; batched lookups.
    const humanIds = [...new Set(rows.filter(r => r.actorKind === "human" && r.actorId).map(r => r.actorId!))];
    const agentIds = [...new Set(rows.filter(r => r.actorKind === "agent" && r.actorId).map(r => r.actorId!))];
    const humanRows = humanIds.length
      ? await db.select({ id: users.id, username: users.username, name: users.name }).from(users).where(inArray(users.id, humanIds))
      : [];
    const agentRows = agentIds.length
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const humanName = new Map(humanRows.map(u => [u.id, u.username ?? u.name ?? null]));
    const agentName = new Map(agentRows.map(a => [a.id, a.name]));
    const named = rows.map(r => ({
      ...r,
      actorName: r.actorId
        ? (r.actorKind === "human" ? humanName.get(r.actorId) ?? null
          : r.actorKind === "agent" ? agentName.get(r.actorId) ?? null
          : null)
        : null,
    }));

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(auditEvents).where(eq(auditEvents.repoId, repo.id));

    return c.json({ events: named, total: Number(total) });
  });

  return app;
}
