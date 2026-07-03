import { and, eq, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { subscriptions } from "../models/schema.js";
import { activeTrial } from "./invites.js";
import { ForbiddenError } from "./errors.js";

// Plan entitlements — the single source of truth for what each tier grants.
// Billing is per-AGENT for Team (matches the landing page "$12/agent/mo").
// Nothing is gated below unless a route calls requireEntitlement; existing
// public/dogfood repos are unaffected. See issue #8 + docs (pricing).
export type Plan = "free" | "pro" | "team" | "enterprise";

export interface Entitlements {
  privateRepos: boolean;
  sso: boolean;
  auditLogExport: boolean;
  branchProtection: boolean;
  standingAgents: number; // cap on concurrently-attached standing agents (Infinity = unlimited)
  // Platform-keyed review/verify allotments (M7, sized by D10). `platformReviews` is
  // the per-TENANT (org XOR user) pool of platform-keyed reviews/month, summed across
  // ALL the tenant's repos — NOT per-repo (the per-repo hole let a free tenant mint
  // repos for unbounded COGS). `verifyCredits` the included verify runs. Overage is
  // metered ($0.10/review, $2.00/verify — D1). Infinity = unmetered (enterprise BYO).
  platformReviews: number;
  verifyCredits: number;
  // D10 abuse caps (per tenant). Free is a HARD cap (byo_fallback beyond); paid pools
  // are SOFT (overage billed), so these Infinity-out for paid. `reviewDailyCap` bounds
  // a burst; `reviewMaxRepos` bounds minted-repo abuse; `inputTokens{Monthly,Daily}`
  // bound giant-diff farming beyond the per-review 50k truncation.
  reviewDailyCap: number;
  reviewMaxRepos: number;
  inputTokensMonthly: number;
  inputTokensDaily: number;
}

export const TIERS: Record<Plan, Entitlements> = {
  // "Price the humans, meter the machines": per-seat, not per-agent. Caps per D10.
  free:       { privateRepos: false, sso: false, auditLogExport: false, branchProtection: false, standingAgents: 0,        platformReviews: 100, verifyCredits: 0,        reviewDailyCap: 10,       reviewMaxRepos: 3,        inputTokensMonthly: 2_000_000, inputTokensDaily: 120_000 },
  pro:        { privateRepos: true,  sso: false, auditLogExport: true,  branchProtection: true,  standingAgents: 10,       platformReviews: 250, verifyCredits: 10,       reviewDailyCap: Infinity, reviewMaxRepos: Infinity, inputTokensMonthly: Infinity,  inputTokensDaily: Infinity },
  team:       { privateRepos: true,  sso: true,  auditLogExport: true,  branchProtection: true,  standingAgents: 10,       platformReviews: 250, verifyCredits: 10,       reviewDailyCap: Infinity, reviewMaxRepos: Infinity, inputTokensMonthly: Infinity,  inputTokensDaily: Infinity },
  enterprise: { privateRepos: true,  sso: true,  auditLogExport: true,  branchProtection: true,  standingAgents: Infinity, platformReviews: Infinity, verifyCredits: Infinity, reviewDailyCap: Infinity, reviewMaxRepos: Infinity, inputTokensMonthly: Infinity,  inputTokensDaily: Infinity },
};

const PLAN_RANK: Record<string, number> = { free: 0, pro: 1, team: 2, enterprise: 3 };

export function entitlementsFor(plan: Plan): Entitlements { return TIERS[plan] ?? TIERS.free; }

/**
 * Resolve the effective plan for an owner (org and/or user) from active
 * subscriptions + an active org trial. Defaults to "free". Takes the highest
 * plan if multiple apply.
 */
export async function planFor(db: DB, owner: { orgId?: string | null; userId?: string | null }): Promise<Plan> {
  let plan: Plan = "free";
  const conds = [];
  if (owner.orgId) conds.push(eq(subscriptions.orgId, owner.orgId));
  if (owner.userId) conds.push(eq(subscriptions.userId, owner.userId));
  if (conds.length) {
    const where = conds.length === 1 ? conds[0] : or(...conds)!;
    const rows = await db.select().from(subscriptions).where(and(eq(subscriptions.status, "active"), where));
    for (const r of rows) if ((PLAN_RANK[r.plan] ?? 0) > PLAN_RANK[plan]) plan = r.plan as Plan;
  }
  if (owner.orgId) {
    const trial = await activeTrial(db, owner.orgId);
    if (trial && (PLAN_RANK[trial.plan] ?? 0) > PLAN_RANK[plan]) plan = trial.plan as Plan;
  }
  return plan;
}

/** Throw `upgrade_required` (403) if `plan` doesn't grant a boolean feature. */
export function requireEntitlement(plan: Plan, key: keyof Entitlements): void {
  const v = entitlementsFor(plan)[key];
  if (v === false || v === 0) throw new ForbiddenError(`this feature requires a paid plan (${key})`, "upgrade_required");
}
