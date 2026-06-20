import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, changes, standingAgents } from "../models/schema.js";
import { computeAgentQuality, type QualityScore } from "./agent-quality.js";

// Earned autonomy: a proven agent earns the right to merge its OWN low-risk work
// without a separate reviewer — measured, not configured. This is the "trust
// scales without a human bottleneck" piece of the fleet model. It is deliberately
// narrow: LOW RISK ONLY, and it never bypasses the sensitive-path / human-approval
// gates in merge-policy (those force a human regardless of who approves). So even
// a maximally-trusted agent still cannot self-merge a migration, a deploy change,
// or anything medium+. See docs/agent-roles.md.

export const EARNED = {
  minMergeRate: Number(process.env.CLAWHUB_AUTONOMY_MIN_MERGE_RATE ?? 80), // % of opened changes merged
  maxRevertRate: Number(process.env.CLAWHUB_AUTONOMY_MAX_REVERT_RATE ?? 5), // % of merges later reverted
  maxDrift: Number(process.env.CLAWHUB_AUTONOMY_MAX_DRIFT ?? 20),
  minMergedVolume: Number(process.env.CLAWHUB_AUTONOMY_MIN_MERGED ?? 5), // track record (anti-fluke)
};

/** Pure: does a quality score (with a known merged-volume) clear the earned bar? */
export function qualityClearsBar(q: QualityScore, mergedVolume: number): boolean {
  return mergedVolume >= EARNED.minMergedVolume
    && q.mergeRate >= EARNED.minMergeRate
    && q.revertRate <= EARNED.maxRevertRate
    && q.driftScore <= EARNED.maxDrift;
}

/** Does this agent currently have earned autonomy? Requires (1) a role that opts in, (2) a track record, (3) quality clears the bar. */
export async function agentEarnedAutonomy(db: DB, agentId: string | null | undefined): Promise<boolean> {
  if (!agentId) return false;
  // (1) The agent must be deployed under at least one role that grants earned autonomy.
  const optIn = (await db.select({ id: agentRoles.id }).from(standingAgents)
    .innerJoin(agentRoles, eq(standingAgents.roleId, agentRoles.id))
    .where(and(eq(standingAgents.agentId, agentId), eq(agentRoles.earnedAutonomy, true))).limit(1))[0];
  if (!optIn) return false;
  // (2) Track record: enough merged changes that the rates aren't noise.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(changes)
    .where(and(eq(changes.openedByAgentId, agentId), eq(changes.status, "merged")));
  const mergedVolume = Number(n ?? 0);
  if (mergedVolume < EARNED.minMergedVolume) return false;
  // (3) Quality clears the bar (computed fresh — autonomy shouldn't ride a stale score).
  const q = await computeAgentQuality(db, agentId);
  return qualityClearsBar(q, mergedVolume);
}

/** Given a set of agent ids, the subset that currently has earned autonomy (batch). */
export async function earnedAutonomyAgents(db: DB, agentIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!agentIds.length) return out;
  // Pre-filter to agents with an opt-in role (cheap), then check quality per agent.
  const optedIn = await db.select({ agentId: standingAgents.agentId }).from(standingAgents)
    .innerJoin(agentRoles, eq(standingAgents.roleId, agentRoles.id))
    .where(and(inArray(standingAgents.agentId, agentIds), eq(agentRoles.earnedAutonomy, true)));
  const candidates = Array.from(new Set(optedIn.map(r => r.agentId).filter(Boolean) as string[]));
  for (const id of candidates) if (await agentEarnedAutonomy(db, id)) out.add(id);
  return out;
}
