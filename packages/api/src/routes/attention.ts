import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, orgMembers, organizations, repositories, reviews } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";

const RISK_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * The effective risk that the rest of the governance model (merge-policy,
 * risk-engine) enforces: server-computed wins over agent-declared, but never
 * lowers it. Mirrors the dashboard's `effectiveRisk()` helper so the triage
 * queue ranks and badges by the same risk the merge gate gates on.
 */
function effectiveRisk(ch: { risk: string; computedRisk?: string | null }): string {
  const computed = ch.computedRisk;
  if (!computed) return ch.risk;
  const declaredRank = RISK_ORDER[ch.risk] ?? 9;
  const computedRank = RISK_ORDER[computed] ?? 9;
  // Lower rank number == higher risk, so the more dangerous one wins.
  return computedRank < declaredRank ? computed : ch.risk;
}

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

    // Approval counts decide the headline reason: no approvals → the reviewer
    // is the bottleneck; approvals but unmerged → it is ready to land.
    const approvals = new Map<string, number>();
    if (open.length) {
      for (const r of await db.select().from(reviews).where(inArray(reviews.changeId, open.map(c => c.id)))) {
        if (r.verdict === "approve") approvals.set(r.changeId, (approvals.get(r.changeId) ?? 0) + 1);
      }
    }

    const items = open.map(ch => {
      const repo = repoById.get(ch.repoId)!;
      // Badge by effective risk — the same value the merge gate enforces — so a
      // change the agent declared `low` but the engine computed `high` still
      // surfaces as high-risk to the supervisor.
      const effRisk = effectiveRisk(ch);
      return {
        change: ch,
        repo: { ns: nsNames.get(repo.namespaceId) ?? "?", name: repo.name },
        reasons: [
          ...(ch.escalated ? ["escalated"] : []),
          ...(ch.status === "pending" && !(approvals.get(ch.id) ?? 0) ? ["awaiting review"] : []),
          ...(ch.status === "pending" && (approvals.get(ch.id) ?? 0) > 0 ? ["approved — ready to merge"] : []),
          ...(effRisk === "high" || effRisk === "critical" ? [`${effRisk} risk`] : []),
          ...(ch.hasConflicts ? ["merge conflicts"] : []),
          ...(ch.status === "changes_requested" ? ["changes requested"] : []),
          ...(ch.ciStatus === "failure" ? ["CI failing"] : []),
        ],
      };
    }).sort((a, b) => {
      if (a.change.escalated !== b.change.escalated) return a.change.escalated ? -1 : 1;
      // Rank by effective risk so the most dangerous (and most blocked) changes
      // surface first — not the agent's self-declared risk.
      const r = (RISK_ORDER[effectiveRisk(a.change)] ?? 9) - (RISK_ORDER[effectiveRisk(b.change)] ?? 9);
      if (r !== 0) return r;
      return new Date(a.change.createdAt).getTime() - new Date(b.change.createdAt).getTime();
    });

    return c.json({ items: items.slice(0, 50) });
  });

  return app;
}
