import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, repoLoops, repositories, standingAgents } from "../models/schema.js";
import type { RepoLoop } from "../models/schema.js";
import { createRole, deployRoleToRepo } from "./agent-roles.js";
import { normalizeMergePolicy, RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS, type MergePolicy } from "./merge-policy.js";
import { ValidationError, ConflictError, NotFoundError } from "./errors.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// The autonomous Loop (M8): package the disconnected roles — developer → verified-
// reviewer (→ optional triager) — into one install, with a policy DIAL. The zero-
// human pipeline already exists; this is the packaging + the conformance contract.
// Zero human involvement is a POLICY dial (earned autonomy at low / verified
// autonomy at medium with the floor ON / human above), never an architectural gap.

export type Autonomy = "review_only" | "low" | "medium";
const AUTONOMY = new Set<Autonomy>(["review_only", "low", "medium"]);

/** sha256 of a normalized merge policy — the uninstall guard against clobbering human edits. */
function policySha(policy: MergePolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/**
 * Apply the autonomy dial onto a repo's current policy. review_only leaves the
 * gate as-is (roles open Changes, humans review); low relies on the developer
 * role's earned autonomy for its own low-risk work; medium turns on verified
 * autonomy (maxRisk medium) with the RECOMMENDED floor ON + hands-off auto-merge.
 */
export function applyAutonomyDial(current: MergePolicy, autonomy: Autonomy): MergePolicy {
  const base = { ...current } as MergePolicy & Record<string, unknown>;
  if (autonomy === "medium") {
    base.verifiedAutonomy = {
      enabled: true, maxRisk: "medium", allowSensitivePaths: false,
      floorGlobs: RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS,
      // Inferred-spec attestations still cap at low even at medium autonomy —
      // the tenant earns the rest by writing issues/descriptions.
      maxInferredSpecRisk: "low",
    } as MergePolicy["verifiedAutonomy"];
    (base as Record<string, unknown>).autoMergeOnVerified = true;
  } else {
    // low / review_only: no verified autonomy from the Loop (earned autonomy on the
    // developer role covers low-risk self-merge without the platform-verify path).
    delete (base as Record<string, unknown>).verifiedAutonomy;
    (base as Record<string, unknown>).autoMergeOnVerified = false;
  }
  return normalizeMergePolicy(base);
}

async function repoOwner(db: DB, repoId: string): Promise<{ ownerType: "user" | "org"; ownerId: string } | null> {
  const repo = (await db.select({ nsType: repositories.namespaceType, nsId: repositories.namespaceId }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (repo?.nsType === "org") return { ownerType: "org", ownerId: repo.nsId };
  if (repo?.nsType === "user") return { ownerType: "user", ownerId: repo.nsId };
  return null;
}

// The Loop's WORK cadence: how often the developer (and issue-scout, if any) FIRE.
// The developer role template ships `continuous` (hourly) — for a hands-off Loop
// that would grind through the backlog around the clock and burn tokens with no
// ceiling. The Loop instead pins the work agents to a SCHEDULE so the loop advances
// on a predictable, bounded cadence (default: once a day). The reviewer stays
// event-driven — it must react to a Change the moment it opens, not on a timer.
export const LOOP_CADENCES: Record<string, string> = {
  daily: "0 6 * * *",       // 06:00 UTC — one dev cycle/day (the safe default)
  twice_daily: "0 6,18 * * *",
  hourly: "0 * * * *",      // opt-in higher throughput (still capped by budget + rate)
  weekly: "0 6 * * 1",      // Mondays 06:00 UTC
};
export interface InstallLoopInput { repoId: string; userId: string; autonomy: Autonomy; includeTriager?: boolean; cadence?: keyof typeof LOOP_CADENCES }

/**
 * Install the Loop on a repo: create + deploy a developer and a verified-reviewer
 * (and optionally a triager), set the policy dial, and record it. BYO-key only in
 * v1 — the deployed roles use the owner's keys (the developer gets earnedAutonomy).
 */
export async function installLoop(db: DB, input: InstallLoopInput): Promise<RepoLoop> {
  if (!AUTONOMY.has(input.autonomy)) throw new ValidationError(`autonomy must be one of ${[...AUTONOMY].join(", ")}`);
  const existing = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, input.repoId)).limit(1))[0];
  if (existing) throw new ConflictError("a Loop is already installed on this repo — uninstall it first");
  const owner = await repoOwner(db, input.repoId);
  if (!owner) throw new NotFoundError("repo owner");

  // Create the roles from templates, deploy each. The developer gets earnedAutonomy
  // ONLY when the dial permits agent self-merge: low/medium enable it; "review_only"
  // means humans merge everything, so it MUST be false (else "Review only" silently
  // grants low-risk agent self-merge — the dial and the role would disagree).
  const developer = await createRole(db, { ...owner, template: "developer", earnedAutonomy: input.autonomy !== "review_only", createdByUserId: input.userId });
  await deployRoleToRepo(db, developer, input.repoId, input.userId);
  const reviewer = await createRole(db, { ...owner, template: "verified-reviewer", createdByUserId: input.userId });
  await deployRoleToRepo(db, reviewer, input.repoId, input.userId);
  let triagerRoleId: string | null = null;
  if (input.includeTriager) {
    const triager = await createRole(db, { ...owner, template: "triager", createdByUserId: input.userId });
    await deployRoleToRepo(db, triager, input.repoId, input.userId);
    triagerRoleId = triager.id;
  }

  // GATE THE WORK CADENCE (anti-infinite-loop). Pin the developer to a SCHEDULE so
  // it fires on a bounded cadence (default daily: one dev cycle/day) instead of the
  // template's `continuous` hourly loop. The reviewer + triager stay event-driven
  // (they must react to a Change/Issue immediately and are far cheaper). Combined
  // with the mandatory Loop budget below, this makes "turn it on and walk away"
  // safe: at most one developer run per cadence tick, hard-stopped at the budget.
  const cadenceCron = LOOP_CADENCES[input.cadence ?? "daily"] ?? LOOP_CADENCES.daily;
  await db.update(standingAgents)
    .set({ trigger: "schedule", cron: cadenceCron, event: null })
    .where(and(eq(standingAgents.repoId, input.repoId), eq(standingAgents.roleId, developer.id)));

  // Apply the policy dial + record the sha so uninstall can detect human edits.
  const repo = (await db.select().from(repositories).where(eq(repositories.id, input.repoId)).limit(1))[0];
  const nextPolicy = applyAutonomyDial(normalizeMergePolicy(repo.mergePolicy), input.autonomy);
  await db.update(repositories).set({ mergePolicy: nextPolicy, updatedAt: new Date() }).where(eq(repositories.id, input.repoId));

  const [row] = await db.insert(repoLoops).values({
    repoId: input.repoId, autonomy: input.autonomy,
    developerRoleId: developer.id, reviewerRoleId: reviewer.id, triagerRoleId,
    appliedPolicySha: policySha(nextPolicy), status: "active", createdByUserId: input.userId,
  }).returning();
  metrics.inc("clawhub_loop_installed_total", { autonomy: input.autonomy });
  log("info", "loop_installed", { repoId: input.repoId, autonomy: input.autonomy });
  return row;
}

async function loopRoleIds(loop: RepoLoop): Promise<string[]> {
  return [loop.developerRoleId, loop.reviewerRoleId, loop.triagerRoleId].filter((x): x is string => !!x);
}

/** Deployed standing agents belonging to a Loop's roles (for status + kill/resume). */
async function loopStandingAgents(db: DB, loop: RepoLoop) {
  const roleIds = await loopRoleIds(loop);
  if (!roleIds.length) return [];
  return db.select().from(standingAgents).where(and(eq(standingAgents.repoId, loop.repoId), inArray(standingAgents.roleId, roleIds)));
}

/** Pause (kill) or resume the Loop's deployed agents + flip its status. */
export async function setLoopEnabled(db: DB, repoId: string, enabled: boolean): Promise<void> {
  const loop = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, repoId)).limit(1))[0];
  if (!loop) throw new NotFoundError("loop");
  const roleIds = await loopRoleIds(loop);
  if (roleIds.length) {
    await db.update(standingAgents).set({ enabled, status: enabled ? "idle" : "paused" })
      .where(and(eq(standingAgents.repoId, repoId), inArray(standingAgents.roleId, roleIds)));
  }
  await db.update(repoLoops).set({ status: enabled ? "active" : "killed", updatedAt: new Date() }).where(eq(repoLoops.id, loop.id));
}

/**
 * Uninstall the Loop: remove its deployed agents + delete its roles, and REVERT
 * the policy only if the repo's current policy still matches the sha we applied
 * (a human edit since install → leave the policy untouched). Deletes the record.
 */
export async function uninstallLoop(db: DB, repoId: string): Promise<{ policyReverted: boolean }> {
  const loop = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, repoId)).limit(1))[0];
  if (!loop) throw new NotFoundError("loop");
  // Remove deployed agents + delete the roles.
  const roleIds = await loopRoleIds(loop);
  if (roleIds.length) {
    await db.delete(standingAgents).where(and(eq(standingAgents.repoId, repoId), inArray(standingAgents.roleId, roleIds)));
    await db.delete(agentRoles).where(inArray(agentRoles.id, roleIds));
  }
  // Revert the policy only if untouched since install.
  let policyReverted = false;
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (repo && loop.appliedPolicySha && policySha(normalizeMergePolicy(repo.mergePolicy)) === loop.appliedPolicySha) {
    const reverted = applyAutonomyDial(normalizeMergePolicy(repo.mergePolicy), "review_only");
    await db.update(repositories).set({ mergePolicy: reverted, updatedAt: new Date() }).where(eq(repositories.id, repoId));
    policyReverted = true;
  }
  await db.delete(repoLoops).where(eq(repoLoops.id, loop.id));
  metrics.inc("clawhub_loop_uninstalled_total", {});
  return { policyReverted };
}

export interface LoopStatus {
  loop: RepoLoop;
  roles: Array<{ id: string; name: string; capability: string }>;
  agents: Array<{ id: string; name: string; status: string; enabled: boolean; consecutiveFailures: number; lastRunAt: Date | null }>;
}

export async function loopStatus(db: DB, repoId: string): Promise<LoopStatus | null> {
  const loop = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, repoId)).limit(1))[0];
  if (!loop) return null;
  const roleIds = await loopRoleIds(loop);
  const roles = roleIds.length ? await db.select({ id: agentRoles.id, name: agentRoles.name, capability: agentRoles.capability }).from(agentRoles).where(inArray(agentRoles.id, roleIds)) : [];
  const sas = await loopStandingAgents(db, loop);
  return {
    loop, roles,
    agents: sas.map(s => ({ id: s.id, name: s.name, status: s.status, enabled: s.enabled, consecutiveFailures: s.consecutiveFailures, lastRunAt: s.lastRunAt })),
  };
}
