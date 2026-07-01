import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories } from "../models/schema.js";
import type { AgentMemory } from "../models/schema.js";
import { extractTrigrams } from "./code-index.js";

// Memory retrieval core. Pure-where-possible so the ranking can be unit-tested
// without a DB. Reuses the exact trigram primitive the code index uses
// (extractTrigrams) — candidate selection is the same "intersect required
// trigrams, then rank" pattern. ClawHub runs NO model here: every signal
// (recency, importance, lexical relevance, scope, path) is arithmetic. See
// docs/memory.md.

export type MemoryScope = "agent" | "repo" | "agent_repo" | "org";

/** Trigrams over a memory's searchable text. */
export function memoryTrigrams(title: string, body: string, tags: string[] = []): string[] {
  return extractTrigrams(`${title}\n${body}\n${tags.join(" ")}`);
}

/** The single scope key a write targets. */
export function scopeKeyOf(scope: MemoryScope, ids: { agentId?: string | null; repoId?: string | null; orgId?: string | null }): string {
  switch (scope) {
    case "agent_repo": return `agent_repo:${ids.agentId}:${ids.repoId}`;
    case "repo": return `repo:${ids.repoId}`;
    case "agent": return `agent:${ids.agentId}`;
    case "org": return `org:${ids.orgId}`;
  }
}

/**
 * The union of scope keys a run may READ — its own agent_repo, the repo, the
 * agent, and (if any) the org. Resolved server-side from the run's agent/repo —
 * never client-supplied, so a run can't read another repo's/agent's memory.
 */
export function readScopeKeys(ids: { agentId?: string | null; repoId?: string | null; orgId?: string | null }): string[] {
  const keys: string[] = [];
  if (ids.agentId && ids.repoId) keys.push(`agent_repo:${ids.agentId}:${ids.repoId}`);
  if (ids.repoId) keys.push(`repo:${ids.repoId}`);
  if (ids.agentId) keys.push(`agent:${ids.agentId}`);
  if (ids.orgId) keys.push(`org:${ids.orgId}`);
  return keys;
}

// --- Scoring (Park et al. recency·importance·relevance, as arithmetic) ---

export interface RankWeights { rel: number; imp: number; rec: number; scope: number; path: number; graph: number }
export const DEFAULT_WEIGHTS: RankWeights = { rel: 1, imp: 1, rec: 1, scope: 0.5, path: 0.5, graph: 0.5 };

const SCOPE_PRECEDENCE: Record<MemoryScope, number> = { agent_repo: 1, repo: 0.7, org: 0.5, agent: 0.3 };
const KIND_IMPORTANCE_BASE: Record<string, number> = { decision: 8, convention: 7, expertise: 6, failure: 6, episode: 3 };
/** Cross-author memories (another agent's notes) are trusted less than your own. */
const CROSS_AUTHOR_TRUST = 0.7;

/** recency = 0.995^(hours since last access) — fresh on creation, refreshed on read. */
export function recency(lastUsedAt: Date, now: Date): number {
  const hours = Math.max(0, (now.getTime() - lastUsedAt.getTime()) / 3_600_000);
  return Math.pow(0.995, hours);
}

/**
 * Importance is a self-rated FLOOR, cross-checked against a deterministic ceiling
 * (mirrors risk-engine's max(declared, computed) — here a min(self, ceiling)) so
 * an agent rating everything 10 can't dominate retrieval. The ceiling rewards
 * being grounded in a real artifact, novel, and proven-useful.
 */
export function heuristicCeiling(m: Pick<AgentMemory, "kind" | "facts" | "useCount">, novelty: number): number {
  const f = (m.facts ?? {}) as Record<string, unknown>;
  let c = KIND_IMPORTANCE_BASE[m.kind] ?? 3;
  if (f.errorFingerprint || f.changeId) c += 2;   // grounded in a real artifact
  c += Math.round(Math.max(0, Math.min(1, novelty)) * 2); // 0..2 for novelty
  if ((m.useCount ?? 0) > 0) c += 1;              // proven useful
  return Math.max(1, Math.min(10, c));
}

export function effectiveImportance(selfRated: number, ceiling: number): number {
  return Math.max(1, Math.min(selfRated, ceiling));
}

export interface RankContext {
  queryTrigrams: string[];
  now: Date;
  changedPaths?: string[];
  weights?: RankWeights;
  ownAgentId?: string | null; // memories authored by other agents are down-weighted
  graphProximity?: Map<string, number>; // graph-walk proximity per memory id (services/memory-graph.ts)
}

/** Lexical relevance: fraction of the query's trigrams present in the memory. */
export function lexicalRelevance(queryTrigrams: string[], memTrigrams: string[]): number {
  if (!queryTrigrams.length) return 0;
  const set = new Set(memTrigrams);
  let hit = 0;
  for (const t of queryTrigrams) if (set.has(t)) hit++;
  return hit / queryTrigrams.length;
}

// Path relation on `/`-segment boundaries — equal, or one is an ancestor dir of
// the other. (Raw string prefixes would mis-match "src/a" against "src/api/x".)
function pathRelated(a: string, b: string): boolean {
  return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

function pathOverlap(facts: unknown, changedPaths?: string[]): number {
  if (!changedPaths?.length) return 0;
  const paths = ((facts as { paths?: unknown })?.paths);
  if (!Array.isArray(paths)) return 0;
  let n = 0;
  for (const p of paths) if (typeof p === "string" && changedPaths.some(c => pathRelated(c, p))) n++;
  return n;
}

export interface ScoredMemory { memory: AgentMemory; score: number; legs: Record<string, number> }

/**
 * Rank candidates by a weighted sum of the five legs, times a trust multiplier for
 * cross-author memories. The unbounded legs (rel, rec, path) are min-max normalized
 * over the candidate set; imp (∈[0.1,1]) and scope (∈[0.3,1]) are already bounded
 * ratios. Pinned (always) and grounded/reviewed open decisions are floated to the
 * top. Pure — no DB, no model.
 */
export function rankMemories(candidates: AgentMemory[], ctx: RankContext): ScoredMemory[] {
  if (!candidates.length) return [];
  const w = ctx.weights ?? DEFAULT_WEIGHTS;
  // Precompute each candidate's trigram set once (noveltyOf is O(n²); rebuilding
  // sets per pair over up to 500 rows was the hot path).
  const triSets = new Map<string, Set<string>>(candidates.map(m => [m.id, new Set(m.trigrams as string[])]));
  const noveltyOf = (m: AgentMemory): number => {
    const mt = triSets.get(m.id)!;
    if (mt.size === 0) return 0.5;
    let maxSim = 0;
    for (const o of candidates) {
      if (o.id === m.id) continue;
      const ot = triSets.get(o.id)!;
      if (!ot.size) continue;
      let inter = 0; for (const t of ot) if (mt.has(t)) inter++;
      const sim = inter / (mt.size + ot.size - inter); // |∩| / |∪|, no new Set
      if (sim > maxSim) maxSim = sim;
    }
    return 1 - maxSim;
  };

  const raw = candidates.map(m => {
    const rel = (m.embedding && false) ? 0 : lexicalRelevance(ctx.queryTrigrams, m.trigrams as string[]); // cosine leg is a flagged Stage-2
    const imp = effectiveImportance(m.importance, heuristicCeiling(m, noveltyOf(m))) / 10;
    const rec = recency(m.lastUsedAt, ctx.now);
    const scopeP = SCOPE_PRECEDENCE[m.scope as MemoryScope] ?? 0.5;
    const path = pathOverlap(m.facts, ctx.changedPaths);
    // Graph proximity: how strongly this memory is CONNECTED (via edges / shared
    // code entities) to the seed set — 0 when it wasn't reached by the walk.
    const graph = ctx.graphProximity?.get(m.id) ?? 0;
    return { m, rel, imp, rec, scopeP, path, graph };
  });

  // Min-max normalize the unbounded legs over the candidate set.
  const norm = (vals: number[]) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    const span = max - min;
    return (v: number) => (span === 0 ? (max === 0 ? 0 : 1) : (v - min) / span);
  };
  const nRel = norm(raw.map(r => r.rel));
  const nRec = norm(raw.map(r => r.rec));
  const nPath = norm(raw.map(r => r.path));
  const nGraph = norm(raw.map(r => r.graph));

  const scored: ScoredMemory[] = raw.map(r => {
    const legs = { rel: nRel(r.rel), imp: r.imp, rec: nRec(r.rec), scope: r.scopeP, path: nPath(r.path), graph: nGraph(r.graph) };
    let score = w.rel * legs.rel + w.imp * legs.imp + w.rec * legs.rec + w.scope * legs.scope + w.path * legs.path + w.graph * legs.graph;
    const crossAuthor = !!(ctx.ownAgentId && r.m.createdByAgentId && r.m.createdByAgentId !== ctx.ownAgentId);
    if (crossAuthor) score *= CROSS_AUTHOR_TRUST;
    // Pinned rows always float to the top. A decision floats ONLY if it's grounded
    // in a real artifact or human-reviewed — so an agent can't self-confer top rank
    // by writing kind:"decision" (it still ranks normally via the legs otherwise).
    if (r.m.pinned) score += 100;
    else if (r.m.kind === "decision" && !r.m.validTo && (r.m.reviewedBy || (r.m.facts as { changeId?: unknown })?.changeId)) score += 10;
    return { memory: r.m, score, legs: { ...legs, crossAuthor: crossAuthor ? 1 : 0 } };
  });

  return scored.sort((a, b) => b.score - a.score);
}

// --- DB candidate selection ---

/**
 * Pull live, in-scope candidate rows and intersect required query trigrams. With
 * no query, returns all live in-scope rows (recency/importance still rank them).
 * Excludes invalidated (validTo), archived, quarantined, and expired rows unless
 * `asOf` is given (bi-temporal point-in-time read).
 */
export async function candidateMemories(
  db: DB,
  scopeKeys: string[],
  query: string | undefined,
  opts: { kind?: string; fingerprint?: string; asOf?: Date; limit?: number; now?: Date } = {},
): Promise<AgentMemory[]> {
  if (!scopeKeys.length) return [];
  const now = opts.now ?? new Date();
  const conds = [inArray(agentMemories.scopeKey, scopeKeys), isNull(agentMemories.quarantinedAt)];
  if (opts.asOf) {
    conds.push(lte(agentMemories.validFrom, opts.asOf));
    conds.push(or(isNull(agentMemories.validTo), sql`${agentMemories.validTo} > ${opts.asOf}`)!);
  } else {
    conds.push(isNull(agentMemories.validTo));
    conds.push(isNull(agentMemories.archivedAt));
    conds.push(or(isNull(agentMemories.expiresAt), sql`${agentMemories.expiresAt} > ${now}`)!);
  }
  if (opts.kind) conds.push(eq(agentMemories.kind, opts.kind as AgentMemory["kind"]));
  if (opts.fingerprint) conds.push(sql`${agentMemories.facts} ->> 'errorFingerprint' = ${opts.fingerprint}`);

  // ORDER BY before the LIMIT so the kept rows are the BEST, not an arbitrary 500
  // (the in-process trigram filter + ranker only see what survives the LIMIT).
  const rows = await db.select().from(agentMemories).where(and(...conds))
    .orderBy(desc(agentMemories.pinned), desc(agentMemories.importance), desc(agentMemories.lastUsedAt))
    .limit(opts.limit ?? 500);
  if (!query || query.length < 3) return rows;
  const required = extractTrigrams(query);
  if (!required.length) return rows;
  return rows.filter(r => {
    const set = new Set(r.trigrams as string[]);
    let hit = 0; for (const t of required) if (set.has(t)) hit++;
    // Recall-friendly: pass if the overlap is meaningful relative to EITHER the
    // query OR the (often shorter) memory, or the absolute overlap is strong, or
    // it's pinned. A short relevant note must not be hard-dropped on a long query —
    // the ranker decides final order.
    const denom = Math.max(1, Math.min(required.length, set.size));
    return hit / denom >= 0.3 || hit >= 4 || r.pinned;
  });
}
