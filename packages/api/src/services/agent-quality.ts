import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentQualityScores, agents, changes, ciRuns, reviews } from "../models/schema.js";

export interface QualityScore {
  agentId: string;
  mergeRate: number;     // merged / opened, *100
  revertRate: number;    // reverted / merged, *100
  timeToGreenCiP50: number; // seconds, 0 if unknown
  reviewHitRate: number; // approved reviews / total reviews, *100
  driftScore: number;    // ewma-style delta across buckets, 0-100
  updatedAt: Date;
}

export async function computeAgentQuality(db: DB, agentId: string): Promise<QualityScore> {
  const open = await db.select({ c: sql<number>`count(*)::int` }).from(changes).where(eq(changes.openedByAgentId, agentId));
  const opened = Number(open[0]?.c ?? 0);

  const merged = (await db.select({ c: sql<number>`count(*)::int` }).from(changes).where(and(eq(changes.openedByAgentId, agentId), eq(changes.status, "merged"))))[0]?.c ?? 0;
  const reverted = (await db.select({ c: sql<number>`count(*)::int` }).from(changes).where(and(eq(changes.openedByAgentId, agentId), eq(changes.status, "rolled_back"))))[0]?.c ?? 0;

  const mergeRate = opened > 0 ? Math.round((Number(merged) / opened) * 100) : 0;
  const revertRate = Number(merged) > 0 ? Math.round((Number(reverted) / Number(merged)) * 100) : 0;

  // Time-to-green CI: median (from change.createdAt to first successful ci_run).
  const ttgRows = await db.execute<{ seconds: number }>(sql`
    select extract(epoch from (first_success.finished_at - c.created_at))::int as seconds
    from changes c
    join lateral (
      select min(finished_at) as finished_at
      from ci_runs r where r.change_id = c.id and r.status = 'success'
    ) as first_success on true
    where c.opened_by_agent_id = ${agentId}
      and first_success.finished_at is not null
  `);
  const seconds = (Array.isArray(ttgRows) ? ttgRows : ((ttgRows as unknown as { rows?: Array<{ seconds: number }> }).rows ?? []))
    .map(r => Number(r.seconds))
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);
  const p50 = seconds.length ? seconds[Math.floor(seconds.length / 2)] : 0;

  // Review hit rate: fraction of reviews authored by this agent where verdict was "approve".
  const allRev = await db.select().from(reviews).where(and(eq(reviews.reviewerKind, "agent"), eq(reviews.reviewerId, agentId)));
  const hit = allRev.filter(r => r.verdict === "approve").length;
  const reviewHitRate = allRev.length ? Math.round((hit / allRev.length) * 100) : 0;

  // Drift score: compare last-7-days merge rate to prior-7-days. Bigger swing = more drift.
  const drift = await computeDrift(db, agentId);

  const score: QualityScore = {
    agentId, mergeRate, revertRate, timeToGreenCiP50: p50, reviewHitRate, driftScore: drift, updatedAt: new Date(),
  };

  await db.insert(agentQualityScores).values({
    agentId,
    mergeRate: score.mergeRate,
    revertRate: score.revertRate,
    timeToGreenCiP50: score.timeToGreenCiP50,
    reviewHitRate: score.reviewHitRate,
    driftScore: score.driftScore,
    updatedAt: score.updatedAt,
  }).onConflictDoUpdate({
    target: agentQualityScores.agentId,
    set: {
      mergeRate: score.mergeRate,
      revertRate: score.revertRate,
      timeToGreenCiP50: score.timeToGreenCiP50,
      reviewHitRate: score.reviewHitRate,
      driftScore: score.driftScore,
      updatedAt: score.updatedAt,
    },
  });

  return score;
}

async function computeDrift(db: DB, agentId: string): Promise<number> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000);

  const thisWeek = await db.select().from(changes).where(and(eq(changes.openedByAgentId, agentId), gt(changes.createdAt, weekAgo)));
  const lastWeek = await db.select().from(changes).where(and(eq(changes.openedByAgentId, agentId), gt(changes.createdAt, twoWeeksAgo)));

  const a = thisWeek.filter(c => c.status === "merged").length / Math.max(thisWeek.length, 1);
  const b = lastWeek.filter(c => c.status === "merged").length / Math.max(lastWeek.length, 1);
  return Math.round(Math.abs(a - b) * 100);
}

export async function getQuality(db: DB, agentId: string): Promise<QualityScore | null> {
  const row = (await db.select().from(agentQualityScores).where(eq(agentQualityScores.agentId, agentId)).limit(1))[0];
  if (!row) return null;
  return {
    agentId: row.agentId,
    mergeRate: row.mergeRate,
    revertRate: row.revertRate,
    timeToGreenCiP50: row.timeToGreenCiP50,
    reviewHitRate: row.reviewHitRate,
    driftScore: row.driftScore,
    updatedAt: row.updatedAt,
  };
}

export async function recomputeAll(db: DB, limit = 200): Promise<number> {
  const all = await db.select().from(agents).limit(limit);
  let n = 0;
  for (const a of all) { try { await computeAgentQuality(db, a.id); n++; } catch {} }
  return n;
}
