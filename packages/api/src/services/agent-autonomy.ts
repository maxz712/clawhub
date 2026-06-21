import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, agentVersions, changes, orgAgentRegistry, standingAgents } from "../models/schema.js";
import { computeAgentQuality, type QualityScore } from "./agent-quality.js";
import { MIN_AUTONOMY_TIER, tierRank } from "./trust-tiers.js";

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

// Trust-tier rank + the autonomy floor live in trust-tiers.ts so the
// version-promotion path shares the exact same vocabulary and threshold.
// Self-merge demands at least `standard` (the tier just below `trusted`), so a
// human who parked an agent/version at sandbox/untrusted has actually withheld
// autonomy, not just decorated a UI.

/**
 * Does the agent's org-registry enrollment ALLOW earned-autonomy self-merge?
 * - No enrollment in any org → null tier → allowed (preserves pre-registry behavior).
 * - Enrolled somewhere → the LOWEST tier across enrollments must be ≥ `standard`.
 *   A `sandbox`/`untrusted` tier in ANY org that enrolled this agent blocks
 *   self-merge: the registry is the human's lever, so the most-restrictive wins.
 * This function has no org/repo context (the callers don't carry one), so it
 * fails closed conservatively rather than picking a "best" tier.
 */
export async function registryTierAllowsAutonomy(db: DB, agentId: string): Promise<boolean> {
  const rows = await db.select({ trustTier: orgAgentRegistry.trustTier }).from(orgAgentRegistry)
    .where(eq(orgAgentRegistry.agentId, agentId));
  if (!rows.length) return true; // not governed by any org registry — unchanged behavior
  const min = Math.min(...rows.map(r => tierRank(r.trustTier)));
  return min >= tierRank(MIN_AUTONOMY_TIER);
}

/**
 * Does the agent's CURRENT version trust tier ALLOW earned-autonomy self-merge?
 * The version tier is the per-version trust lever. Crucially, every path an
 * AGENT can drive on its own — self-asserting a tier at registration, or a
 * self-reported eval — is capped at `sandbox` (the anti-gaming ceiling; see
 * trust-tiers.ts + routes/agent-versions.ts). Reaching `standard`+ requires a
 * HUMAN to promote the version. So this gate can only be SATISFIED by a human
 * decision, never self-granted. The agent's LATEST registered version (by
 * createdAt) is the one in flight, so it is the floor: a version below
 * `standard` cannot self-merge even if the agent's historical quality clears
 * the bar — shipping a fresh untrusted version withdraws autonomy until it is
 * re-vetted by a human.
 * - No declared versions → allowed (preserves pre-versioning behavior; an agent
 *   that never registers versions is governed only by quality + the registry).
 */
export async function versionTierAllowsAutonomy(db: DB, agentId: string): Promise<boolean> {
  const latest = (await db.select({ trustTier: agentVersions.trustTier }).from(agentVersions)
    .where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.createdAt)).limit(1))[0];
  if (!latest) return true; // no declared versions — unchanged behavior
  return tierRank(latest.trustTier) >= tierRank(MIN_AUTONOMY_TIER);
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
  // (3a) Org trust gate: if a human enrolled this agent in an org registry, the
  // tier they assigned is the lever. Below `standard` (sandbox/untrusted) blocks
  // self-merge regardless of quality. No enrollment → unchanged. This NEVER
  // grants autonomy the quality bar would deny — it only takes it away.
  if (!(await registryTierAllowsAutonomy(db, agentId))) return false;
  // (3b) Per-version trust gate: the agent's latest registered version must be
  // at `standard`+. Self-reported evals can only earn up to `sandbox` (the
  // anti-gaming ceiling), so reaching the autonomy-conferring `standard` tier
  // requires a human-granted promotion. No declared versions → unchanged. Also
  // never grants autonomy quality would deny — only takes it away.
  if (!(await versionTierAllowsAutonomy(db, agentId))) return false;
  // (4) Quality clears the bar (computed fresh — autonomy shouldn't ride a stale score).
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
