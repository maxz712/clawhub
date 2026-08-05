import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, repositories, reviews } from "../models/schema.js";

/**
 * PUBLIC AGGREGATE RULE (#122): every public surface filters on repo visibility,
 * AGGREGATES INCLUDED.
 *
 * The row-returning public endpoints always filtered `repositories.isPublic`; the
 * counts next to them did not, so `/public/agents/:name` happily published
 * `changesMerged: 57` from private repos in the same response whose `repos` list
 * it had just redacted to `[]`. Polling that unauthenticated endpoint yielded a
 * private team's delivery-rate time series.
 *
 * This module is the ONE place those counts are computed. The four copy-pasted
 * `count(*) from changes where opened_by_agent_id = …` queries (profile, badge,
 * og, leaderboard) all route through it — drift between copies is exactly how
 * the leak happened, so there is now only one copy.
 *
 * `changesOpened` / `reviewsSubmitted` are ALSO computed here rather than read
 * from the denormalized `agents.stats` blob: that counter is bumped on every
 * push (`post-push.ts`, `ref-rewriter.ts`) and every review (`routes/reviews.ts`)
 * with no visibility condition, so the stored number is an already-mixed
 * private+public total that no read-time predicate can un-mix. `agents.stats`
 * remains the internal lifetime total; these are the publishable figures.
 */
export interface PublicAgentStats {
  changesOpened: number;
  changesMerged: number;
  reviewsSubmitted: number;
}

export function emptyPublicAgentStats(): PublicAgentStats {
  return { changesOpened: 0, changesMerged: 0, reviewsSubmitted: 0 };
}

/**
 * Public-repo-only counts for MANY agents in two grouped queries — so the
 * leaderboard (which needs every agent) costs O(1) round trips, not O(agents).
 * Pass `agentIds` to restrict; omit for the whole instance.
 *
 * Agents with no public activity are simply absent from the map (callers treat
 * a miss as all-zero, which is also the "hide this agent" signal for the
 * leaderboard and sitemap).
 */
export async function publicAgentStatsBulk(db: DB, agentIds?: string[]): Promise<Map<string, PublicAgentStats>> {
  const out = new Map<string, PublicAgentStats>();
  if (agentIds && agentIds.length === 0) return out;

  const at = (id: string): PublicAgentStats => {
    let s = out.get(id);
    if (!s) { s = emptyPublicAgentStats(); out.set(id, s); }
    return s;
  };

  const changeWhere: Array<SQL | undefined> = [
    eq(repositories.isPublic, true),
    sql`${changes.openedByAgentId} is not null`,
  ];
  if (agentIds) changeWhere.push(inArray(changes.openedByAgentId, agentIds));
  const changeRows = await db.select({
    agentId: changes.openedByAgentId,
    opened: sql<number>`count(*)::int`,
    merged: sql<number>`(count(*) filter (where ${changes.status} = 'merged'))::int`,
  }).from(changes)
    .innerJoin(repositories, eq(changes.repoId, repositories.id))
    .where(and(...changeWhere))
    .groupBy(changes.openedByAgentId);
  for (const r of changeRows) {
    if (!r.agentId) continue;
    const s = at(r.agentId);
    s.changesOpened = Number(r.opened) || 0;
    s.changesMerged = Number(r.merged) || 0;
  }

  // A review lives in a repo only transitively (review → change → repo), so the
  // visibility predicate needs both joins.
  const reviewWhere: Array<SQL | undefined> = [
    eq(repositories.isPublic, true),
    eq(reviews.reviewerKind, "agent"),
  ];
  if (agentIds) reviewWhere.push(inArray(reviews.reviewerId, agentIds));
  const reviewRows = await db.select({
    agentId: reviews.reviewerId,
    submitted: sql<number>`count(*)::int`,
  }).from(reviews)
    .innerJoin(changes, eq(reviews.changeId, changes.id))
    .innerJoin(repositories, eq(changes.repoId, repositories.id))
    .where(and(...reviewWhere))
    .groupBy(reviews.reviewerId);
  for (const r of reviewRows) {
    if (!r.agentId) continue;
    at(r.agentId).reviewsSubmitted = Number(r.submitted) || 0;
  }

  return out;
}

/** Public-repo-only counts for ONE agent. All-zero when it has no public work. */
export async function publicAgentStats(db: DB, agentId: string): Promise<PublicAgentStats> {
  const m = await publicAgentStatsBulk(db, [agentId]);
  return m.get(agentId) ?? emptyPublicAgentStats();
}

export function hasPublicActivity(s: PublicAgentStats | undefined): boolean {
  return !!s && (s.changesOpened > 0 || s.changesMerged > 0 || s.reviewsSubmitted > 0);
}
