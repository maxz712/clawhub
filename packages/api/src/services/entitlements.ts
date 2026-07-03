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
  // Platform-keyed review/verify allotments (M7). `platformReviews` is the pool
  // of platform-keyed reviews included per month (free = per-repo Haiku pool; pro
  // = per-seat pool); `verifyCredits` the included verify runs. Overage is metered
  // ($0.10/review, $2.00/verify — D1). Infinity = unmetered (enterprise BYO/self-host).
  platformReviews: number;
  verifyCredits: number;
}

export const TIERS: Record<Plan, Entitlements> = {
  // "Price the humans, meter the machines": per-seat, not per-agent.
  free:       { privateRepos: false, sso: false, auditLogExport: false, branchProtection: false, standingAgents: 0,        platformReviews: 50,  verifyCredits: 0 },
  pro:        { privateRepos: true,  sso: false, auditLogExport: true,  branchProtection: true,  standingAgents: 10,       platformReviews: 500, verifyCredits: 10 },
  team:       { privateRepos: true,  sso: true,  auditLogExport: true,  branchProtection: true,  standingAgents: 10,       platformReviews: 500, verifyCredits: 10 },
  enterprise: { privateRepos: true,  sso: true,  auditLogExport: true,  branchProtection: true,  standingAgents: Infinity, platformReviews: Infinity, verifyCredits: Infinity },
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
