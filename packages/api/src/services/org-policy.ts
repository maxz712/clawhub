import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMergePolicy } from "../models/schema.js";
import { type MergePolicy, normalizeMergePolicy } from "./merge-policy.js";

// Org-level default merge policy. Applied to NEW org repos at creation (the
// system default is used otherwise). After creation, the per-repo policy + an
// in-repo .clawhub/policies/merge.yml still override — this only seeds the
// starting point so a manager governing N repos doesn't hand-edit each one.

export async function getOrgMergePolicy(db: DB, orgId: string): Promise<MergePolicy | null> {
  const row = (await db.select().from(orgMergePolicy).where(eq(orgMergePolicy.orgId, orgId)).limit(1))[0];
  return row ? (row.policy as MergePolicy) : null;
}

export async function setOrgMergePolicy(db: DB, orgId: string, raw: unknown): Promise<MergePolicy> {
  // Coerce to a complete, well-formed policy before persisting — a free-form PUT
  // body that's missing required fields would otherwise brick/weaken merge gating
  // on every NEW org repo that inherits it (one bad object, N repos of fan-out).
  const policy = normalizeMergePolicy(raw);
  await db.insert(orgMergePolicy).values({ orgId, policy, updatedAt: new Date() })
    .onConflictDoUpdate({ target: orgMergePolicy.orgId, set: { policy, updatedAt: new Date() } });
  return policy;
}

export async function clearOrgMergePolicy(db: DB, orgId: string): Promise<void> {
  await db.delete(orgMergePolicy).where(eq(orgMergePolicy.orgId, orgId));
}
