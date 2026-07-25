import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { featureFlags, type FeatureFlag } from "../models/schema.js";

export interface FlagRule {
  match?: { userId?: string | string[]; email?: string | string[]; agentId?: string | string[] };
  enabled: boolean;
}

export async function upsertFlag(db: DB, input: {
  repoId?: string | null;
  key: string;
  description?: string;
  enabled?: boolean;
  rolloutPercent?: number;
  rules?: FlagRule[];
}): Promise<FeatureFlag> {
  // Scope the existing-row lookup to the exact scope being upserted: a global
  // (repoId IS NULL) upsert must NOT match a repo-scoped row that shares the
  // key, and vice versa — otherwise a global write silently overwrites a repo's
  // flag (same class of cross-repo bug that hardened deleteFlag, audit 2026-06-20).
  const existing = (await db.select().from(featureFlags).where(and(
    input.repoId ? eq(featureFlags.repoId, input.repoId) : isNull(featureFlags.repoId),
    eq(featureFlags.key, input.key),
  )).limit(1))[0];

  if (existing) {
    const [row] = await db.update(featureFlags).set({
      description: input.description ?? existing.description,
      enabled: input.enabled ?? existing.enabled,
      rolloutPercent: input.rolloutPercent ?? existing.rolloutPercent,
      rules: (input.rules ?? existing.rules) as unknown as Record<string, unknown>[],
      updatedAt: new Date(),
    }).where(eq(featureFlags.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(featureFlags).values({
    repoId: input.repoId ?? null,
    key: input.key,
    description: input.description ?? null,
    enabled: input.enabled ?? false,
    rolloutPercent: input.rolloutPercent ?? 0,
    rules: (input.rules ?? []) as unknown as Record<string, unknown>[],
  }).returning();
  return row;
}

export async function evaluate(db: DB, input: {
  key: string;
  repoId?: string | null;
  context: { userId?: string; email?: string; agentId?: string };
}): Promise<{ enabled: boolean; reason: string }> {
  // A global evaluate (repoId null/falsy) must resolve ONLY the true global row
  // (repoId IS NULL) — never a same-keyed repo-scoped row from an unrelated repo,
  // which would leak that repo's enabled/rollout/targeting rules to any caller.
  const flag = (await db.select().from(featureFlags).where(
    input.repoId
      ? and(eq(featureFlags.repoId, input.repoId), eq(featureFlags.key, input.key))
      : and(isNull(featureFlags.repoId), eq(featureFlags.key, input.key))
  ).limit(1))[0];
  if (!flag) return { enabled: false, reason: "flag_missing" };
  if (!flag.enabled) return { enabled: false, reason: "flag_disabled" };

  const rules = (flag.rules as FlagRule[]) ?? [];
  for (const r of rules) {
    if (r.match) {
      const ok = matches(r.match.userId, input.context.userId)
        || matches(r.match.email, input.context.email)
        || matches(r.match.agentId, input.context.agentId);
      if (ok) return { enabled: r.enabled, reason: "rule_match" };
    }
  }

  if (flag.rolloutPercent >= 100) return { enabled: true, reason: "rollout_100" };
  if (flag.rolloutPercent <= 0) return { enabled: false, reason: "rollout_0" };

  const ident = input.context.userId ?? input.context.email ?? input.context.agentId ?? "anon";
  const bucket = bucketFor(input.key, ident);
  const on = bucket < flag.rolloutPercent;
  return { enabled: on, reason: `rollout_${flag.rolloutPercent}_bucket_${bucket}` };
}

function matches(pattern: string | string[] | undefined, value?: string): boolean {
  if (!pattern || !value) return false;
  if (Array.isArray(pattern)) return pattern.includes(value);
  return pattern === value;
}

function bucketFor(key: string, ident: string): number {
  const h = createHash("sha256").update(`${key}:${ident}`).digest();
  const n = h.readUInt32BE(0);
  return n % 100;
}

export async function listFlags(db: DB, repoId?: string | null): Promise<FeatureFlag[]> {
  if (repoId) return db.select().from(featureFlags).where(eq(featureFlags.repoId, repoId));
  return db.select().from(featureFlags);
}

export async function deleteFlag(db: DB, repoId: string, id: string): Promise<void> {
  // Scoped to the repo so a flag id from another repo can't be deleted here.
  await db.delete(featureFlags).where(and(eq(featureFlags.id, id), eq(featureFlags.repoId, repoId)));
}
