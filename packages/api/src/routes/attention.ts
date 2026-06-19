import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, orgMembers, repoCollaborators, repositories, reviews } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { namespaceNameOf } from "../services/namespace.js";

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

    // Collect the repos visible to the caller (owned, supervised, or granted).
    const repos: Array<typeof repositories.$inferSelect> = [];
    const seen = new Set<string>();
    const add = (rows: Array<typeof repositories.$inferSelect>) => {
      for (const r of rows) if (!seen.has(r.id)) { repos.push(r); seen.add(r.id); }
    };

    if (p.kind === "user") {
      const myAgents = await db.select().from(agents).where(eq(agents.associatedUserId, p.userId));
      const ownerUserIds = [p.userId, ...myAgents.map(a => a.serviceUserId).filter((x): x is string => !!x)];
      add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "user"), inArray(repositories.namespaceId, ownerUserIds))));
      const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, p.userId));
      const orgIds = memberships.map(m => m.orgId);
      if (orgIds.length) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), inArray(repositories.namespaceId, orgIds))));
      if (myAgents.length) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), inArray(repositories.namespaceId, myAgents.map(a => a.id)))));
    } else {
      const grants = await db.select().from(repoCollaborators).where(eq(repoCollaborators.agentId, p.agentId));
      const repoIds = grants.map(g => g.repoId);
      if (repoIds.length) add(await db.select().from(repositories).where(inArray(repositories.id, repoIds)));
      add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, p.agentId))));
    }
    if (!repos.length) return c.json({ items: [] });

    // Display namespace name per repo (cached by namespace id).
    const nsNames = new Map<string, string>();
    for (const r of repos) {
      if (!nsNames.has(r.namespaceId)) nsNames.set(r.namespaceId, (await namespaceNameOf(db, r.namespaceType, r.namespaceId)) ?? "?");
    }
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
