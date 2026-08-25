import { minimatch } from "minimatch";
import { eq, and, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentQuotas, agentUsage, type AgentQuota } from "../models/schema.js";
import type { Risk } from "./trailer-parser.js";
import { ForbiddenError } from "./errors.js";

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export async function getQuota(db: DB, agentId: string): Promise<AgentQuota> {
  const row = (await db.select().from(agentQuotas).where(eq(agentQuotas.agentId, agentId)).limit(1))[0];
  if (row) return row;
  const [inserted] = await db.insert(agentQuotas).values({ agentId }).returning();
  return inserted;
}

export async function upsertQuota(db: DB, agentId: string, patch: Partial<Omit<AgentQuota, "id" | "agentId" | "updatedAt">>): Promise<AgentQuota> {
  const existing = await getQuota(db, agentId);
  const [updated] = await db.update(agentQuotas)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agentQuotas.id, existing.id))
    .returning();
  return updated;
}

function windowKey(kind: "api" | "push" | "review", now = new Date()): string {
  const iso = now.toISOString();
  return `${kind}:${iso.slice(0, 13)}`; // hour window
}

export async function bumpUsage(db: DB, agentId: string, kind: "api" | "push" | "review"): Promise<number> {
  const window = windowKey(kind);
  // Atomic single-statement increment. The old read-then-write (SELECT count →
  // +1 in JS → UPDATE) lost updates under concurrency: N simultaneous requests
  // could all read the same value and each write count+1, so the persisted count
  // ended up far below N and enforceRate never tripped — letting agents blow past
  // their push/review/api quotas (#92). INSERT ... ON CONFLICT DO UPDATE takes a
  // row lock on the conflicting `(agentId, window, kind)` row, so concurrent
  // callers serialize on it and each sees a distinct, correct post-increment
  // value in RETURNING. Targets the existing `agent_usage_uniq` unique index.
  const [row] = await db.insert(agentUsage)
    .values({ agentId, window, kind, count: 1 })
    .onConflictDoUpdate({
      target: [agentUsage.agentId, agentUsage.window, agentUsage.kind],
      set: { count: sql`${agentUsage.count} + 1` },
    })
    .returning({ count: agentUsage.count });
  return row.count;
}

export async function currentUsage(db: DB, agentId: string, kind: "api" | "push" | "review"): Promise<number> {
  const existing = (await db.select().from(agentUsage)
    .where(and(eq(agentUsage.agentId, agentId), eq(agentUsage.window, windowKey(kind)), eq(agentUsage.kind, kind)))
    .limit(1))[0];
  return existing?.count ?? 0;
}

export async function enforceRate(db: DB, agentId: string, kind: "api" | "push" | "review"): Promise<void> {
  const quota = await getQuota(db, agentId);
  const limit = kind === "api" ? quota.apiPerHour : kind === "push" ? quota.pushPerHour : quota.reviewPerHour;
  const after = await bumpUsage(db, agentId, kind);
  if (limit > 0 && after > limit) {
    throw new ForbiddenError(`agent_rate_limited:${kind}:${limit}/hr`, "agent_rate_limited");
  }
}

export interface ScopeCheckInput {
  /** GIT-derived changed paths, unioned with the declared `Scope:` trailer (#205)
   *  — the declaration may only WIDEN the checked set, never narrow it. */
  paths: string[];
  /** EFFECTIVE risk — max(declared, computed), the merge gate's value (#205). */
  risk: Risk;
  loc?: number;
  /** True when git gave no path list and `paths` is back-filled from the agent's
   *  own trailers — self-reported data a configured path quota must not trust. */
  pathsDegraded?: boolean;
}

export async function enforceScope(db: DB, agentId: string, input: ScopeCheckInput): Promise<void> {
  const quota = await getQuota(db, agentId);
  const allow = (quota.pathAllowlist as string[]) ?? [];
  const deny = (quota.pathDenylist as string[]) ?? [];

  // Fail CLOSED when a path quota is configured but the path list is degraded
  // (numstat failed → back-filled from the declared Scope trailer): a gate that
  // silently falls back to self-reported data is the bypass it exists to stop.
  if (input.pathsDegraded && (allow.length || deny.length)) {
    throw new ForbiddenError("agent_scope_violation:paths_unavailable", "scope_violation");
  }

  if (allow.length) {
    const bad = input.paths.filter(p => !allow.some(g => minimatch(p, g)));
    if (bad.length) throw new ForbiddenError(`agent_scope_violation:path_not_allowed:${bad[0]}`, "scope_violation");
  }
  for (const p of input.paths) {
    if (deny.some(g => minimatch(p, g))) {
      throw new ForbiddenError(`agent_scope_violation:path_denied:${p}`, "scope_violation");
    }
  }

  if (RISK_ORDER[input.risk] > RISK_ORDER[quota.riskCeiling as Risk]) {
    throw new ForbiddenError(`agent_scope_violation:risk_ceiling:${quota.riskCeiling}`, "scope_violation");
  }

  if (quota.maxLocPerChange > 0 && typeof input.loc === "number" && input.loc > quota.maxLocPerChange) {
    throw new ForbiddenError(`agent_scope_violation:max_loc:${quota.maxLocPerChange}`, "scope_violation");
  }
}
