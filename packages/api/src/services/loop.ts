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
// Composable loop PRESETS — one-click loop shapes. Each names which roles turn on;
// per-role specs (below) override, so the presets are just convenient defaults.
export const LOOP_PRESETS = {
  full:         { scout: true,  developer: true,  reviewer: true,  triager: false }, // files → builds → verifies → merges (hands-off at autonomy=medium)
  "dev-review": { scout: false, developer: true,  reviewer: true,  triager: false }, // you file issues; it builds + verifies + merges
  "scout-dev":  { scout: true,  developer: true,  reviewer: false, triager: false }, // files + builds; you review + merge
  scout:        { scout: true,  developer: false, reviewer: false, triager: false }, // just keeps the backlog full
  dev:          { scout: false, developer: true,  reviewer: false, triager: false }, // just builds assigned issues
  review:       { scout: false, developer: false, reviewer: true,  triager: false }, // just verifies opened Changes
} as const;
export type LoopPreset = keyof typeof LOOP_PRESETS;

// Per-role knobs. `prompt` is the custom instruction that makes a role YOURS — a
// scout's focus area ("look for missing tests in packages/api"), a dev's standing
// directive, a reviewer's focus. It sets the deployed agent's task. `cadence` +
// `devKind` apply only where meaningful (scout/developer are scheduled; the reviewer
// + triager are event-driven, so their cadence is ignored).
export interface LoopRoleSpec { enabled?: boolean; prompt?: string; cadence?: keyof typeof LOOP_CADENCES; devKind?: "ui" | "code" }

// Resolve WHICH roles a loop deploys. A preset gives defaults; an explicit per-role
// `spec.enabled` (even `false`) overrides via the leading `??`. The deprecated
// include* flags are FORCE-ON aliases combined with `||` (NOT `??`) so a concrete
// `false` (which the route always sends) can't suppress a preset that turns the role
// on — the preset default still wins. Pure + exported so the resolution is unit-tested.
export function resolveLoopRoles(
  input: Pick<InstallLoopInput, "preset" | "scout" | "developer" | "reviewer" | "triager" | "includeScout" | "includeTriager">,
): { scout: boolean; developer: boolean; reviewer: boolean; triager: boolean } {
  const base = input.preset && Object.prototype.hasOwnProperty.call(LOOP_PRESETS, input.preset)
    ? LOOP_PRESETS[input.preset]
    : { scout: false, developer: true, reviewer: true, triager: false };
  return {
    scout:     input.scout?.enabled     ?? (input.includeScout   || base.scout),
    developer: input.developer?.enabled ?? base.developer,
    reviewer:  input.reviewer?.enabled  ?? base.reviewer,
    triager:   input.triager?.enabled   ?? (input.includeTriager || base.triager),
  };
}

export interface InstallLoopInput {
  repoId: string; userId: string; autonomy: Autonomy;
  preset?: LoopPreset;                 // resolves to a default role set; the specs below override it
  scout?: LoopRoleSpec; developer?: LoopRoleSpec; reviewer?: LoopRoleSpec; triager?: LoopRoleSpec;
  cadence?: keyof typeof LOOP_CADENCES; // default cadence for scheduled roles (per-role spec.cadence wins)
  // Back-compat aliases (deprecated; folded into the specs above).
  includeTriager?: boolean; includeScout?: boolean; devKind?: "ui" | "code";
}

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

  // Resolve WHICH roles this loop deploys. A preset gives defaults; per-role specs
  // (and the deprecated include* flags) override. With neither, default to the classic
  // developer + reviewer bundle so old callers are unchanged.
  if (input.preset && !Object.prototype.hasOwnProperty.call(LOOP_PRESETS, input.preset)) throw new ValidationError(`unknown preset "${input.preset}" — one of ${Object.keys(LOOP_PRESETS).join(", ")}`);
  const want = resolveLoopRoles(input);
  if (!want.scout && !want.developer && !want.reviewer && !want.triager)
    throw new ValidationError("a loop needs at least one agent (scout, developer, reviewer, or triager)");
  // Full (medium) autonomy needs a reviewer to PRODUCE the verification that auto-
  // merges; without one the dial is set but nothing ever attests, so nothing merges.
  if (input.autonomy === "medium" && !want.reviewer)
    throw new ValidationError("full autonomy (medium) needs a reviewer to verify + auto-merge — enable the reviewer or lower autonomy");

  // Cadence gating (anti-infinite-loop): scheduled roles (scout + developer) fire on a
  // bounded cadence (default daily) instead of the developer template's `continuous`
  // hourly loop; the reviewer + triager stay event-driven (react immediately, cheap).
  const cadenceOf = (s?: LoopRoleSpec) => LOOP_CADENCES[s?.cadence ?? input.cadence ?? "daily"] ?? LOOP_CADENCES.daily;
  const scheduleRole = (roleId: string, s?: LoopRoleSpec) =>
    db.update(standingAgents).set({ trigger: "schedule", cron: cadenceOf(s), event: null })
      .where(and(eq(standingAgents.repoId, input.repoId), eq(standingAgents.roleId, roleId)));

  let developerRoleId: string | null = null, reviewerRoleId: string | null = null, triagerRoleId: string | null = null, scoutRoleId: string | null = null;

  // Developer: earnedAutonomy only when the dial permits agent self-merge (low/medium).
  // devKind 'code' → worker mode (no browser); 'ui' → develop mode. A custom prompt
  // becomes the dev's task (it builds THAT); left empty it grabs assigned issues (the
  // loop shape — the scout files them).
  if (want.developer) {
    const devTemplate = (input.developer?.devKind ?? input.devKind) === "code" ? "worker" : "developer";
    const dev = await createRole(db, { ...owner, template: devTemplate, task: input.developer?.prompt || undefined, earnedAutonomy: input.autonomy !== "review_only", createdByUserId: input.userId });
    await deployRoleToRepo(db, dev, input.repoId, input.userId);
    await scheduleRole(dev.id, input.developer);
    developerRoleId = dev.id;
  }
  // Reviewer: event-driven (change.opened). A custom prompt narrows its review focus.
  if (want.reviewer) {
    const rev = await createRole(db, { ...owner, template: "verified-reviewer", task: input.reviewer?.prompt || undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, rev, input.repoId, input.userId);
    reviewerRoleId = rev.id;
  }
  // Scout: the FRONT of the loop — files issues on the cadence. A custom prompt is its
  // focus area (where + what to look for).
  if (want.scout) {
    const scout = await createRole(db, { ...owner, template: "issue-scout", task: input.scout?.prompt || undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, scout, input.repoId, input.userId);
    await scheduleRole(scout.id, input.scout);
    scoutRoleId = scout.id;
  }
  // Triager: event-driven (issue.opened) — labels/routes new issues.
  if (want.triager) {
    const triager = await createRole(db, { ...owner, template: "triager", task: input.triager?.prompt || undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, triager, input.repoId, input.userId);
    triagerRoleId = triager.id;
  }

  // Apply the policy dial + record the sha so uninstall can detect human edits.
  const repo = (await db.select().from(repositories).where(eq(repositories.id, input.repoId)).limit(1))[0];
  const nextPolicy = applyAutonomyDial(normalizeMergePolicy(repo.mergePolicy), input.autonomy);
  await db.update(repositories).set({ mergePolicy: nextPolicy, updatedAt: new Date() }).where(eq(repositories.id, input.repoId));

  const [row] = await db.insert(repoLoops).values({
    repoId: input.repoId, autonomy: input.autonomy,
    developerRoleId, reviewerRoleId, triagerRoleId, scoutRoleId,
    appliedPolicySha: policySha(nextPolicy), status: "active", createdByUserId: input.userId,
  }).returning();
  metrics.inc("clawhub_loop_installed_total", { autonomy: input.autonomy });
  log("info", "loop_installed", { repoId: input.repoId, autonomy: input.autonomy });
  return row;
}

async function loopRoleIds(loop: RepoLoop): Promise<string[]> {
  return [loop.developerRoleId, loop.reviewerRoleId, loop.triagerRoleId, loop.scoutRoleId].filter((x): x is string => !!x);
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
