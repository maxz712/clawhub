import { createHash } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentRoles, costLedger, platformBudgets, repoLoops, repositories, standingAgents } from "../models/schema.js";
import { tenantForRepo, ensureLoopBudget } from "./platform-billing.js";
import { platformProvider } from "./llm-catalog.js";
import type { RepoLoop } from "../models/schema.js";
import { createRole, deployRoleToRepo } from "./agent-roles.js";
import { normalizeMergePolicy, RECOMMENDED_VERIFIED_AUTONOMY_FLOOR_GLOBS, type MergePolicy } from "./merge-policy.js";
import { ValidationError, ConflictError, NotFoundError } from "./errors.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// The autonomous Loop (M8): package the disconnected roles — developer → verified-
// reviewer (→ optional triager) — into one install, with a policy DIAL. The zero-
// human pipeline already exists; this is the packaging + the conformance contract.
// Zero human involvement is a POLICY dial (self-review at low / verified autonomy
// at medium with the floor ON / human above), never an architectural gap — and
// never a kind gate: every level is expressed purely as merge POLICY, evaluated
// identically for humans and agents (v3).

export type Autonomy = "review_only" | "low" | "medium";
const AUTONOMY = new Set<Autonomy>(["review_only", "low", "medium"]);

/** sha256 of a normalized merge policy — the uninstall guard against clobbering human edits. */
function policySha(policy: MergePolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/**
 * Apply the autonomy dial onto a repo's current policy — the ONE place the Loop
 * decides how much it may merge on its own. Every level is plain merge POLICY:
 * `evaluateMerge` still takes no actor-kind input, and merge RIGHTS are still the
 * separate role question (`requireMergeRights`).
 *
 *   review_only — gate untouched: roles open Changes, a human merges them.
 *   low         — the developer merges its OWN low-risk work: `allowSelfReview`
 *                 lets the author's approval count toward `minApprovalsTotal`,
 *                 and the human requirement is pinned at MEDIUM risk so only LOW
 *                 flows unattended. The production backstops are deliberately
 *                 left standing — the sensitive-path baseline still forces a
 *                 human on migrations/deploy/policy paths, and the code-review
 *                 gate still fires at high. No hands-off auto-merge: the agent
 *                 asks for the merge and the gate says yes, exactly as a human
 *                 with write access would.
 *   medium      — verified autonomy (maxRisk medium) with the RECOMMENDED
 *                 human-only floor ON + hands-off auto-merge.
 *
 * #136: `low` used to share the `review_only` branch and lean on earned autonomy
 * (`services/agent-autonomy.ts`) for self-merge. v3 retired earned autonomy as a
 * merge mechanism, so the dial silently wrote review_only policy while three
 * surfaces promised self-merge. It is now policy-native and observably different.
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
    // low / review_only: the Loop never turns on verified autonomy or hands-off
    // auto-merge — that is what `medium` buys.
    delete (base as Record<string, unknown>).verifiedAutonomy;
    (base as Record<string, unknown>).autoMergeOnVerified = false;
    // review_only REVOKES self-review rather than leaving it as found. The dial is
    // a ladder, and `uninstallLoop` reverts by re-dialing to review_only — if this
    // branch left `allowSelfReview` alone, uninstalling a `low` loop (or dialing
    // back down) would leave agent self-merge switched on with no Loop to explain
    // it. Same posture the branch already takes with verifiedAutonomy/auto-merge:
    // the dial owns these keys, and the revert direction is the strict one.
    if (autonomy === "review_only") base.allowSelfReview = false;
    if (autonomy === "low") {
      // Self-merge for LOW risk only. `minApprovalsTotal` is raised to at least 1
      // but never LOWERED — a repo that demands two approvals keeps demanding
      // two, so dialing low can't quietly undo a stricter setting.
      base.allowSelfReview = true;
      base.minApprovalsTotal = Math.max(1, current.minApprovalsTotal ?? 1);
      base.requireHumanApproval = "if_risk_at_least";
      base.requireHumanApprovalLevel = "medium";
      base.codeReviewRequiredAtRisk = "high";
      // sensitiveBaseline / pathOverrides / requireCiRun are intentionally not
      // touched: the dial buys low-risk speed, not a weaker sensitive-path gate.
    }
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
  // N5 · zero-setup Loop: "platform" runs the loop's agents through the metering
  // gateway on ClawHub's key — no BYO key to paste. Mandatorily creates the
  // tenant's Loop budget row at install (D10: conservative default, onExhaust
  // block, never draws a seat pool); every dispatch still passes the D10 gates.
  keySource?: "byo" | "platform";
  // BYO key applied to every role the loop creates (sealed at rest by
  // createRole). Absent + byo = the roles run keyless — only correct for a
  // local no-auth model, so the dashboard now asks for this up front.
  llmApiKey?: string;
  // Back-compat aliases (deprecated; folded into the specs above).
  includeTriager?: boolean; includeScout?: boolean; devKind?: "ui" | "code";
}

/**
 * Install the Loop on a repo: create + deploy a developer and a verified-reviewer
 * (and optionally a triager), set the policy dial, and record it. Keys: BYO by
 * default; keySource "platform" (N5) is the zero-setup path — the roles run
 * through the metering gateway on the platform key behind the auto-created
 * Loop budget.
 */
export async function installLoop(db: DB, input: InstallLoopInput): Promise<RepoLoop> {
  if (!AUTONOMY.has(input.autonomy)) throw new ValidationError(`autonomy must be one of ${[...AUTONOMY].join(", ")}`);
  const existing = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, input.repoId)).limit(1))[0];
  if (existing) throw new ConflictError("a Loop is already installed on this repo — uninstall it first");
  const owner = await repoOwner(db, input.repoId);
  if (!owner) throw new NotFoundError("repo owner");

  // CLAIM-FIRST (#93): the read above is a courtesy fast-path, not the guard —
  // two concurrent installs could both pass it and each mint a full set of agent
  // identities + standing agents before the loser finally hit the unique index
  // on the LAST insert, leaking duplicate agents and double-applying the policy
  // dial. Claim the repo_loops row (repoId is UNIQUE) BEFORE provisioning; the
  // loser gets a clean 409 having created nothing. The claim is filled in with
  // role ids + the policy sha at the end; any provisioning failure deletes it so
  // a retry is possible.
  let claim: RepoLoop;
  try {
    claim = (await db.insert(repoLoops).values({
      repoId: input.repoId, autonomy: input.autonomy, status: "installing", createdByUserId: input.userId,
    }).returning())[0];
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ConflictError("a Loop is already installed on this repo — uninstall it first");
    throw e;
  }
  try {

  // N5 platform-key gate: only when this instance actually runs platform inference,
  // and with the D10 Loop cost-center in place BEFORE any role can dispatch.
  const keySource: "byo" | "platform" = input.keySource === "platform" ? "platform" : "byo";
  if (keySource === "platform") {
    if (platformProvider() === "openrouter" ? !process.env.CLAWHUB_PLATFORM_OPENAI_KEY : !process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY) {
      throw new ValidationError("platform inference is not configured on this instance — install the Loop with your own key instead");
    }
    await ensureLoopBudget(db, await tenantForRepo(db, input.repoId));
  }

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

  // Developer: devKind 'code' → worker mode (no browser); 'ui' → develop mode. A
  // custom prompt becomes the dev's task (it builds THAT); left empty it grabs
  // assigned issues (the loop shape — the scout files them).
  // `earnedAutonomy` is NOT keyed off the dial (#136): it is a fleet REPORTING
  // flag with no merge-path consumer since v3 retired earned autonomy from the
  // gate. What the dial permits is written as merge policy by applyAutonomyDial.
  if (want.developer) {
    const devTemplate = (input.developer?.devKind ?? input.devKind) === "code" ? "worker" : "developer";
    const dev = await createRole(db, { ...owner, template: devTemplate, task: input.developer?.prompt || undefined, earnedAutonomy: false, keySource, llmApiKey: keySource === "byo" ? input.llmApiKey : undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, dev, input.repoId, input.userId);
    await scheduleRole(dev.id, input.developer);
    developerRoleId = dev.id;
  }
  // Reviewer: event-driven (change.opened). A custom prompt narrows its review focus.
  if (want.reviewer) {
    const rev = await createRole(db, { ...owner, template: "verified-reviewer", task: input.reviewer?.prompt || undefined, keySource, llmApiKey: keySource === "byo" ? input.llmApiKey : undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, rev, input.repoId, input.userId);
    reviewerRoleId = rev.id;
  }
  // Scout: the FRONT of the loop — files issues on the cadence. A custom prompt is its
  // focus area (where + what to look for).
  if (want.scout) {
    const scout = await createRole(db, { ...owner, template: "issue-scout", task: input.scout?.prompt || undefined, keySource, llmApiKey: keySource === "byo" ? input.llmApiKey : undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, scout, input.repoId, input.userId);
    await scheduleRole(scout.id, input.scout);
    scoutRoleId = scout.id;
  }
  // Triager: event-driven (issue.opened) — labels/routes new issues.
  if (want.triager) {
    const triager = await createRole(db, { ...owner, template: "triager", task: input.triager?.prompt || undefined, keySource, llmApiKey: keySource === "byo" ? input.llmApiKey : undefined, createdByUserId: input.userId });
    await deployRoleToRepo(db, triager, input.repoId, input.userId);
    triagerRoleId = triager.id;
  }

  // Apply the policy dial + record the sha so uninstall can detect human edits.
  const repo = (await db.select().from(repositories).where(eq(repositories.id, input.repoId)).limit(1))[0];
  const nextPolicy = applyAutonomyDial(normalizeMergePolicy(repo.mergePolicy), input.autonomy);
  await db.update(repositories).set({ mergePolicy: nextPolicy, updatedAt: new Date() }).where(eq(repositories.id, input.repoId));

  const [row] = await db.update(repoLoops).set({
    developerRoleId, reviewerRoleId, triagerRoleId, scoutRoleId,
    appliedPolicySha: policySha(nextPolicy), status: "active",
  }).where(eq(repoLoops.id, claim.id)).returning();
  metrics.inc("clawhub_loop_installed_total", { autonomy: input.autonomy });
  log("info", "loop_installed", { repoId: input.repoId, autonomy: input.autonomy });
  return row;
  } catch (e) {
    // Release the claim so the repo isn't wedged "installing" forever; the
    // partially-provisioned roles (if any) are surfaced by the error for manual
    // cleanup — same exposure as before, minus the double-install leak.
    await db.delete(repoLoops).where(eq(repoLoops.id, claim.id)).catch(() => {});
    throw e;
  }
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
  // Spend vs budget for the Loop card. `reportedSpendCents30d` sums the loop
  // agents' self-reported cost_ledger rows (labeled "reported" in the UI — the
  // v1 Loop is BYO-key, so this is the agents' own accounting, not the metered
  // ledger). `budgetMonthlyUsd` is the tenant's platform budget cap when one
  // exists (the auto-created Loop cost-center), else null.
  spend: { reportedSpendCents30d: number; budgetMonthlyUsd: number | null };
}

export async function loopStatus(db: DB, repoId: string): Promise<LoopStatus | null> {
  const loop = (await db.select().from(repoLoops).where(eq(repoLoops.repoId, repoId)).limit(1))[0];
  if (!loop) return null;
  const roleIds = await loopRoleIds(loop);
  const roles = roleIds.length ? await db.select({ id: agentRoles.id, name: agentRoles.name, capability: agentRoles.capability }).from(agentRoles).where(inArray(agentRoles.id, roleIds)) : [];
  const sas = await loopStandingAgents(db, loop);

  let reportedSpendCents30d = 0;
  let budgetMonthlyUsd: number | null = null;
  try {
    const agentIds = [...new Set(sas.map(s => s.agentId).filter((a): a is string => !!a))];
    if (agentIds.length) {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const [row] = await db.select({ total: sql<string>`coalesce(sum(${costLedger.costCents}), 0)` }).from(costLedger)
        .where(and(inArray(costLedger.agentId, agentIds), gte(costLedger.createdAt, since)));
      reportedSpendCents30d = Number(row?.total ?? 0);
    }
    const tenant = await tenantForRepo(db, repoId);
    const budget = tenant.orgId || tenant.userId
      ? (await db.select({ cap: platformBudgets.monthlyCapMicroUsd }).from(platformBudgets)
          .where(tenant.orgId ? eq(platformBudgets.orgId, tenant.orgId) : eq(platformBudgets.userId, tenant.userId!)).limit(1))[0]
      : undefined;
    if (budget && budget.cap > 0) budgetMonthlyUsd = Math.round(budget.cap / 10_000) / 100;
  } catch { /* spend is decoration on the card — never fail the status call over it */ }

  return {
    loop, roles,
    agents: sas.map(s => ({ id: s.id, name: s.name, status: s.status, enabled: s.enabled, consecutiveFailures: s.consecutiveFailures, lastRunAt: s.lastRunAt })),
    spend: { reportedSpendCents30d, budgetMonthlyUsd },
  };
}
