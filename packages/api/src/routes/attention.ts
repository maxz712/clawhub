import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

    // Optional scoping filters (FLEET-MANAGER). These can only NARROW the
    // already-visible set — never widen it. `org=<orgId>` keeps only that org's
    // repos; `repo=<id|ns/name>` keeps a single repo. A filter that matches
    // nothing the caller can see yields an empty queue (no existence leak).
    const orgFilter = c.req.query("org");
    if (orgFilter) {
      for (let i = repos.length - 1; i >= 0; i--) {
        if (!(repos[i].namespaceType === "org" && repos[i].namespaceId === orgFilter)) { seen.delete(repos[i].id); repos.splice(i, 1); }
      }
    }
    const repoFilter = c.req.query("repo");
    if (repoFilter) {
      const want = repoFilter.includes("/") ? repoFilter.split("/").pop()! : repoFilter;
      for (let i = repos.length - 1; i >= 0; i--) {
        if (repos[i].id !== repoFilter && repos[i].name !== want) { seen.delete(repos[i].id); repos.splice(i, 1); }
      }
    }
    if (!repos.length) return c.json({ items: [], total: 0, hasMore: false, limit: 0, offset: 0 });

    // Display namespace name per repo (cached by namespace id).
    const nsNames = new Map<string, string>();
    for (const r of repos) {
      if (!nsNames.has(r.namespaceId)) nsNames.set(r.namespaceId, (await namespaceNameOf(db, r.namespaceType, r.namespaceId)) ?? "?");
    }
    const repoById = new Map(repos.map(r => [r.id, r]));

    // Approved-but-unmerged changes must stay surfaced — they are the supervisor's
    // ready-to-land queue. Dropping them would make the home falsely imply
    // everything is merged.
    // Fetch cap bounds memory for a manager with many open changes; it's high
    // enough that `total` below is accurate in realistic fleets. We still rank +
    // page the result in memory so the headline order (escalated/high-risk
    // first) is honored across the page boundary.
    const FETCH_CAP = 1000;
    const open = await db.select().from(changes)
      .where(and(inArray(changes.repoId, repos.map(r => r.id)), inArray(changes.status, ["pending", "approved", "changes_requested"])))
      .orderBy(desc(changes.updatedAt))
      .limit(FETCH_CAP);

    // Approval counts decide the headline reason: no approvals → the reviewer
    // is the bottleneck; approvals but unmerged → it is ready to land.
    const approvals = new Map<string, number>();
    if (open.length) {
      // Only REAL, current approvals count toward "ready to land": advisory
      // (native-reviewer) verdicts inform but never gate, and superseded verdicts
      // are stale — counting either would falsely mark a change ready. Mirrors the
      // gate's own filters (changes.ts approverCount).
      for (const r of await db.select().from(reviews).where(and(
        inArray(reviews.changeId, open.map(c => c.id)),
        eq(reviews.advisory, false), isNull(reviews.supersededAt),
      ))) {
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
          ...(ch.status === "approved" || (ch.status === "pending" && (approvals.get(ch.id) ?? 0) > 0) ? ["approved — ready to merge"] : []),
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

    // Page the ranked list. `limit` defaults to 50 (the prior "50 shown"),
    // overridable up to 200; `offset` walks the queue. `total` is the count of
    // ranked open changes the caller can see (after any org/repo filter) so the
    // UI can show "showing N of M"; `hasMore` flags a next page.
    const rawLimit = Number(c.req.query("limit"));
    const rawOffset = Number(c.req.query("offset"));
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 200) : 50;
    const total = items.length;
    const page = items.slice(offset, offset + limit);
    return c.json({ items: page, total, hasMore: offset + page.length < total, limit, offset });
  });

  return app;
}
