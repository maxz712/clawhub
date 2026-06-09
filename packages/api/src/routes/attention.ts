import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, orgMembers, organizations, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The supervisor's triage queue: open changes across every repo the caller
 * can see, escalations and high risk first, oldest first within a tier.
 * Users see repos of agents they claimed plus their orgs' repos; agents see
 * their own namespace.
 */
export function createAttentionRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/", async c => {
    const p = c.get("tokenPayload");

    // Resolve visible namespaces → {id → display name}.
    const nsNames = new Map<string, string>();
    let agentIds: string[] = [];
    let orgIds: string[] = [];
    if (p.kind === "user") {
      const myAgents = await db.select().from(agents).where(eq(agents.associatedUserId, p.userId));
      agentIds = myAgents.map(a => { nsNames.set(a.id, a.name); return a.id; });
      const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, p.userId));
      orgIds = memberships.map(m => m.orgId);
      if (orgIds.length) {
        for (const o of await db.select().from(organizations).where(inArray(organizations.id, orgIds))) nsNames.set(o.id, o.name);
      }
    } else {
      agentIds = [p.agentId];
      const me = (await db.select().from(agents).where(eq(agents.id, p.agentId)).limit(1))[0];
      if (me) nsNames.set(me.id, me.name);
    }

    const repoFilters = [];
    if (agentIds.length) repoFilters.push(and(eq(repositories.namespaceType, "agent"), inArray(repositories.namespaceId, agentIds)));
    if (orgIds.length) repoFilters.push(and(eq(repositories.namespaceType, "org"), inArray(repositories.namespaceId, orgIds)));
    if (!repoFilters.length) return c.json({ items: [] });

    const repos = (await Promise.all(repoFilters.map(f => db.select().from(repositories).where(f)))).flat();
    if (!repos.length) return c.json({ items: [] });
    const repoById = new Map(repos.map(r => [r.id, r]));

    const open = await db.select().from(changes)
      .where(and(inArray(changes.repoId, repos.map(r => r.id)), inArray(changes.status, ["pending", "changes_requested"])))
      .orderBy(desc(changes.updatedAt))
      .limit(200);

    const items = open.map(ch => {
      const repo = repoById.get(ch.repoId)!;
      return {
        change: ch,
        repo: { ns: nsNames.get(repo.namespaceId) ?? "?", name: repo.name },
        reasons: [
          ...(ch.escalated ? ["escalated"] : []),
          ...(ch.risk === "high" || ch.risk === "critical" ? [`${ch.risk} risk`] : []),
          ...(ch.hasConflicts ? ["merge conflicts"] : []),
          ...(ch.status === "changes_requested" ? ["changes requested"] : []),
          ...(ch.ciStatus === "failure" ? ["CI failing"] : []),
        ],
      };
    }).sort((a, b) => {
      if (a.change.escalated !== b.change.escalated) return a.change.escalated ? -1 : 1;
      const r = (RISK_ORDER[a.change.risk] ?? 9) - (RISK_ORDER[b.change.risk] ?? 9);
      if (r !== 0) return r;
      return new Date(a.change.createdAt).getTime() - new Date(b.change.createdAt).getTime();
    });

    return c.json({ items: items.slice(0, 50) });
  });

  return app;
}
