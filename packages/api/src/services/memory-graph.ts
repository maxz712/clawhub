import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, memoryEdges } from "../models/schema.js";
import type { MemoryEdge } from "../models/schema.js";
import { readScopeKeys } from "./memory-index.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { metrics } from "./metrics.js";

// Memory GRAPH layer. The agent authors cognitive edges; ClawHub DERIVES mechanical
// ones and walks the graph — all arithmetic, ZERO inference (the same split as the
// notes themselves). Edges only ever connect memories, so authorization is enforced
// on the memory rows an edge touches (every traversal joins the neighbor memory and
// filters it to the caller's scope union) — an edge can never surface a memory the
// reader couldn't already see. See docs/memory.md.

export type EdgeRelation = MemoryEdge["relation"];
/** memory→memory relations (traversable both ways for retrieval-relatedness). */
export const MEMORY_RELATIONS = new Set<EdgeRelation>([
  "relates_to", "refines", "caused_by", "contradicts", "duplicate_of", "depends_on",
]);
/** the one memory→code relation. */
export const CODE_RELATION: EdgeRelation = "about";

export const MEMORY_EDGES_PER_CALL = Number(process.env.CLAWHUB_MEMORY_EDGES_PER_CALL ?? 200);
const MAX_DST_PATH = 1024;
const DERIVE_ABOUT_CAP = 20;   // materialize at most N facts.paths per memory
const DERIVE_FP_STAR_CAP = 12; // link at most N members of a fingerprint cluster

export interface ScopeIds { agentId: string; repoId: string; orgId: string | null }

export interface EdgeInput {
  relation: string;
  dstMemoryId?: string | null;
  dstPath?: string | null;
  weight?: number;
}

/** Repo-relative, deduplicable path form (mirror what the code index stores). */
export function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, "").replace(/\/+$/, "");
}
function clampWeight(w: unknown): number {
  const n = typeof w === "number" && Number.isFinite(w) ? Math.round(w) : 50;
  return Math.max(0, Math.min(100, n));
}

// --- Write (agent-authored, origin='agent') ---------------------------------

/**
 * Insert edges from a source memory. Scope-checked: the src memory (and every
 * memory-typed dst) must be in the caller's read scope, so an agent can't wire a
 * memory it can't see. Deduped via the partial unique indexes (onConflictDoNothing).
 * Idempotent — a re-delivered run's edges are a no-op.
 */
export async function writeEdges(
  db: DB, ids: ScopeIds, srcMemoryId: string, edges: EdgeInput[],
  opts: { sourceRunId?: string | null; origin?: "agent" | "derived" } = {},
): Promise<{ written: number }> {
  if (!edges.length) return { written: 0 };
  if (edges.length > MEMORY_EDGES_PER_CALL) throw new ValidationError(`at most ${MEMORY_EDGES_PER_CALL} edges per call`);
  const scopeKeys = readScopeKeys(ids);

  const src = (await db.select({ id: agentMemories.id, scopeKey: agentMemories.scopeKey })
    .from(agentMemories).where(eq(agentMemories.id, srcMemoryId)).limit(1))[0];
  if (!src) throw new NotFoundError("source memory");
  if (!scopeKeys.includes(src.scopeKey)) throw new ForbiddenError("source memory is outside your scope");

  // Validate all memory-typed destinations in one query.
  const dstMemIds = [...new Set(edges.map(e => e.dstMemoryId).filter((x): x is string => !!x))];
  const dstScope = new Map<string, string>(
    dstMemIds.length
      ? (await db.select({ id: agentMemories.id, scopeKey: agentMemories.scopeKey })
          .from(agentMemories).where(inArray(agentMemories.id, dstMemIds))).map(r => [r.id, r.scopeKey])
      : [],
  );

  const origin = opts.origin ?? "agent";
  const rows: (typeof memoryEdges.$inferInsert)[] = [];
  const dedupe = new Set<string>();
  for (const e of edges) {
    const rel = e.relation as EdgeRelation;
    if (rel === CODE_RELATION) {
      const p = normalizePath(e.dstPath ?? "");
      if (!p) throw new ValidationError("about edge requires dstPath");
      if (p.length > MAX_DST_PATH) throw new ValidationError("dstPath too long");
      const k = `code:${rel}:${p}`;
      if (dedupe.has(k)) continue; dedupe.add(k);
      rows.push({ repoId: ids.repoId, srcMemoryId, dstKind: "code", dstPath: p, relation: rel, weight: clampWeight(e.weight), origin, createdByAgentId: ids.agentId, sourceRunId: opts.sourceRunId ?? null });
    } else if (MEMORY_RELATIONS.has(rel)) {
      const d = e.dstMemoryId;
      if (!d) throw new ValidationError(`${rel} edge requires dstMemoryId`);
      if (d === srcMemoryId) throw new ValidationError("edge cannot be a self-loop");
      const sk = dstScope.get(d);
      if (!sk) throw new NotFoundError("destination memory");
      if (!scopeKeys.includes(sk)) throw new ForbiddenError("destination memory is outside your scope");
      const k = `mem:${rel}:${d}`;
      if (dedupe.has(k)) continue; dedupe.add(k);
      rows.push({ repoId: ids.repoId, srcMemoryId, dstKind: "memory", dstMemoryId: d, relation: rel, weight: clampWeight(e.weight), origin, createdByAgentId: ids.agentId, sourceRunId: opts.sourceRunId ?? null });
    } else {
      throw new ValidationError(`invalid relation "${e.relation}"`);
    }
  }
  if (!rows.length) return { written: 0 };
  const inserted = await db.insert(memoryEdges).values(rows).onConflictDoNothing().returning({ id: memoryEdges.id });
  if (inserted.length) metrics.inc("clawhub_memory_edges_total", { origin }, inserted.length);
  return { written: inserted.length };
}

// --- Derive (mechanical, origin='derived') ----------------------------------

/**
 * Deterministically derive edges for a repo's LIVE memories — no LLM, safe to
 * re-run (deduped by the unique indexes):
 *   • `about`: materialize each memory's `facts.paths` into memory→code edges, so
 *     the diff's changed files can seed retrieval through indexed edges (not just
 *     the in-memory facts.paths scan).
 *   • `relates_to`: memories sharing an `errorFingerprint` are linked (star to the
 *     lowest id) — the same signal `consolidationCandidates` already clusters on.
 * Path-based relatedness is left to the walker's code-hub hop (memory→code→memory),
 * so there's no O(n²) precompute here.
 */
export async function deriveEdgesForRepo(db: DB, repoId: string): Promise<{ written: number }> {
  const mems = await db.select({ id: agentMemories.id, facts: agentMemories.facts })
    .from(agentMemories)
    .where(and(
      eq(agentMemories.repoId, repoId),
      isNull(agentMemories.validTo),
      isNull(agentMemories.archivedAt),
      isNull(agentMemories.quarantinedAt),
    ));

  const rows: (typeof memoryEdges.$inferInsert)[] = [];
  const byFp = new Map<string, string[]>();
  for (const m of mems) {
    const f = (m.facts ?? {}) as { paths?: unknown; errorFingerprint?: unknown };
    if (Array.isArray(f.paths)) {
      const seen = new Set<string>();
      for (const raw of f.paths.slice(0, DERIVE_ABOUT_CAP)) {
        if (typeof raw !== "string") continue;
        const p = normalizePath(raw);
        if (!p || p.length > MAX_DST_PATH || seen.has(p)) continue;
        seen.add(p);
        rows.push({ repoId, srcMemoryId: m.id, dstKind: "code", dstPath: p, relation: "about", weight: 60, origin: "derived" });
      }
    }
    if (typeof f.errorFingerprint === "string" && f.errorFingerprint) {
      let arr = byFp.get(f.errorFingerprint);
      if (!arr) { arr = []; byFp.set(f.errorFingerprint, arr); }
      arr.push(m.id);
    }
  }
  for (const members of byFp.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort();
    const hub = sorted[0];
    for (const id of sorted.slice(1, 1 + DERIVE_FP_STAR_CAP)) {
      rows.push({ repoId, srcMemoryId: id, dstKind: "memory", dstMemoryId: hub, relation: "relates_to", weight: 70, origin: "derived" });
    }
  }
  if (!rows.length) return { written: 0 };
  const inserted = await db.insert(memoryEdges).values(rows).onConflictDoNothing().returning({ id: memoryEdges.id });
  if (inserted.length) metrics.inc("clawhub_memory_edges_total", { origin: "derived" }, inserted.length);
  return { written: inserted.length };
}

// --- Graph walk (retrieval expansion) ---------------------------------------

/** How strongly each relation propagates proximity along a hop (∈[0,1]). */
const RELATION_PROPAGATION: Record<EdgeRelation, number> = {
  duplicate_of: 1.0, refines: 0.9, about: 0.8, relates_to: 0.7, caused_by: 0.7, depends_on: 0.6, contradicts: 0.5,
};
const HOP_DECAY = 0.6;      // each hop attenuates proximity
const DEFAULT_FANOUT = 24;  // cap neighbors expanded per frontier node

export interface GraphExpandOpts { hops?: number; fanout?: number }

/** A weighted directed link surfaced during a walk (frontier memory → neighbor
 *  memory); `prop` ∈(0,1] = edgeWeight·relationDecay for that hop. */
export interface AdjLink { from: string; nbr: string; prop: number }
export type AdjacencyFetcher = (frontierIds: string[]) => Promise<AdjLink[]>;

/**
 * Pure BFS proximity walk over an INJECTABLE adjacency source — the traversal math
 * (fanout cap, per-hop decay, best-path max, cycle-safety, seed removal) with NO DB.
 * `expandByGraph` supplies the real edge fetcher; tests supply a static graph.
 * proximity[reached] = best-path product of frontierScore·prop·HOP_DECAY.
 */
export async function walkFrontiers(seedIds: string[], fetchAdj: AdjacencyFetcher, opts: GraphExpandOpts = {}): Promise<Map<string, number>> {
  const proximity = new Map<string, number>();
  if (!seedIds.length) return proximity;
  const hops = Math.max(1, Math.min(opts.hops ?? 1, 2));
  const fanout = opts.fanout ?? DEFAULT_FANOUT;
  let frontier = new Map<string, number>(seedIds.map(id => [id, 1]));
  const settled = new Set<string>(seedIds);

  for (let depth = 0; depth < hops; depth++) {
    const ids = [...frontier.keys()];
    if (!ids.length) break;
    const adj = new Map<string, AdjLink[]>();
    for (const l of await fetchAdj(ids)) {
      if (l.nbr === l.from) continue;
      let a = adj.get(l.from);
      if (!a) { a = []; adj.set(l.from, a); }
      a.push(l);
    }
    const next = new Map<string, number>();
    for (const [from, neighbors] of adj) {
      const fromScore = frontier.get(from) ?? 0;
      neighbors.sort((a, b) => b.prop - a.prop);
      for (const { nbr, prop } of neighbors.slice(0, fanout)) {
        const score = fromScore * prop * HOP_DECAY;
        if (score <= 0) continue;
        proximity.set(nbr, Math.max(proximity.get(nbr) ?? 0, score));
        if (!settled.has(nbr)) next.set(nbr, Math.max(next.get(nbr) ?? 0, score));
      }
    }
    for (const id of next.keys()) settled.add(id);
    frontier = next;
  }
  for (const s of seedIds) proximity.delete(s);
  return proximity;
}

/**
 * DB-backed adjacency for one frontier: live memory↔memory edges (BOTH directions —
 * for retrieval, "A refines B" makes each relevant to the other) PLUS
 * memory→code→memory (two memories about the same file are related through the code
 * hub). Every neighbor is joined to its memory row and filtered to `scopeKeys`, so
 * traversal never crosses a scope boundary.
 */
async function fetchGraphAdjacency(db: DB, ids: string[], scopeKeys: string[]): Promise<AdjLink[]> {
  const links: AdjLink[] = [];
  // 1) direct memory→memory edges, both directions (neighbor joined + scoped).
  const outMem = await db.select({ from: memoryEdges.srcMemoryId, nbr: memoryEdges.dstMemoryId, relation: memoryEdges.relation, weight: memoryEdges.weight })
    .from(memoryEdges).innerJoin(agentMemories, eq(agentMemories.id, memoryEdges.dstMemoryId))
    .where(and(
      inArray(memoryEdges.srcMemoryId, ids), eq(memoryEdges.dstKind, "memory"),
      isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
      inArray(agentMemories.scopeKey, scopeKeys), isNull(agentMemories.validTo), isNull(agentMemories.quarantinedAt), isNull(agentMemories.archivedAt),
    ));
  for (const e of outMem) if (e.nbr) links.push({ from: e.from, nbr: e.nbr, prop: (e.weight / 100) * (RELATION_PROPAGATION[e.relation] ?? 0.5) });
  const inMem = await db.select({ from: memoryEdges.dstMemoryId, nbr: memoryEdges.srcMemoryId, relation: memoryEdges.relation, weight: memoryEdges.weight })
    .from(memoryEdges).innerJoin(agentMemories, eq(agentMemories.id, memoryEdges.srcMemoryId))
    .where(and(
      inArray(memoryEdges.dstMemoryId, ids), eq(memoryEdges.dstKind, "memory"),
      isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
      inArray(agentMemories.scopeKey, scopeKeys), isNull(agentMemories.validTo), isNull(agentMemories.quarantinedAt), isNull(agentMemories.archivedAt),
    ));
  for (const e of inMem) if (e.from) links.push({ from: e.from, nbr: e.nbr, prop: (e.weight / 100) * (RELATION_PROPAGATION[e.relation] ?? 0.5) });

  // 2) code hub: frontier memory --about--> path --about(reverse)--> other memory.
  const outCode = await db.select({ from: memoryEdges.srcMemoryId, path: memoryEdges.dstPath, weight: memoryEdges.weight })
    .from(memoryEdges)
    .where(and(
      inArray(memoryEdges.srcMemoryId, ids), eq(memoryEdges.dstKind, "code"),
      isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
    ));
  const pathToFrom = new Map<string, Array<{ from: string; w: number }>>();
  for (const e of outCode) {
    if (!e.path) continue;
    let a = pathToFrom.get(e.path);
    if (!a) { a = []; pathToFrom.set(e.path, a); }
    a.push({ from: e.from, w: e.weight });
  }
  const paths = [...pathToFrom.keys()];
  if (paths.length) {
    const others = await db.select({ nbr: memoryEdges.srcMemoryId, path: memoryEdges.dstPath, weight: memoryEdges.weight })
      .from(memoryEdges).innerJoin(agentMemories, eq(agentMemories.id, memoryEdges.srcMemoryId))
      .where(and(
        eq(memoryEdges.dstKind, "code"), inArray(memoryEdges.dstPath, paths),
        isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
        inArray(agentMemories.scopeKey, scopeKeys), isNull(agentMemories.validTo), isNull(agentMemories.quarantinedAt), isNull(agentMemories.archivedAt),
      ));
    for (const o of others) {
      if (!o.path) continue;
      for (const src of pathToFrom.get(o.path) ?? []) {
        // two `about` hops through a shared file — product of both edge weights.
        links.push({ from: src.from, nbr: o.nbr, prop: (src.w / 100) * (o.weight / 100) * RELATION_PROPAGATION.about });
      }
    }
  }
  return links;
}

/**
 * From seed memory ids, walk the live edge graph up to `hops` (≤2) and return a
 * proximity score per REACHED memory (∈(0,1]); seeds are removed (already
 * candidates). DB-backed adjacency; the walk math lives in `walkFrontiers`.
 */
export function expandByGraph(db: DB, seedIds: string[], scopeKeys: string[], opts: GraphExpandOpts = {}): Promise<Map<string, number>> {
  if (!seedIds.length || !scopeKeys.length) return Promise.resolve(new Map());
  return walkFrontiers(seedIds, ids => fetchGraphAdjacency(db, ids, scopeKeys), opts);
}

/**
 * Memories linked (via `about` edges) to any of the given changed paths — the
 * graph seed for "what have agents learned about the files this diff touches".
 * Matches on exact path OR ancestor/descendant dir relation (a memory about
 * `src/api` is relevant to a change under `src/api/x`). Scope-filtered + live.
 */
export async function codeEntitiesToMemories(
  db: DB, repoId: string, changedPaths: string[], scopeKeys: string[], limit = 60,
): Promise<string[]> {
  const paths = [...new Set(changedPaths.map(normalizePath).filter(Boolean))];
  if (!paths.length || !scopeKeys.length) return [];
  // Path relation on `/`-segment boundaries: equal, ancestor, or descendant.
  const clauses = paths.map(p => sql`(${memoryEdges.dstPath} = ${p} or ${memoryEdges.dstPath} like ${p + "/%"} or ${p} like ${memoryEdges.dstPath} || '/%')`);
  const rows = await db.select({ id: memoryEdges.srcMemoryId })
    .from(memoryEdges).innerJoin(agentMemories, eq(agentMemories.id, memoryEdges.srcMemoryId))
    .where(and(
      eq(memoryEdges.repoId, repoId), eq(memoryEdges.dstKind, "code"),
      isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
      sql`(${sql.join(clauses, sql` or `)})`,
      inArray(agentMemories.scopeKey, scopeKeys), isNull(agentMemories.validTo), isNull(agentMemories.quarantinedAt), isNull(agentMemories.archivedAt),
    ))
    .limit(limit);
  return [...new Set(rows.map(r => r.id))];
}

// --- Views + governance -----------------------------------------------------

export interface Neighbor { edge: MemoryEdge; direction: "out" | "in" }

/** One-hop neighbors of a memory (both directions), for the graph view. Scoped. */
export async function neighborsOf(db: DB, memoryId: string): Promise<MemoryEdge[]> {
  return db.select().from(memoryEdges).where(and(
    sql`(${memoryEdges.srcMemoryId} = ${memoryId} or ${memoryEdges.dstMemoryId} = ${memoryId})`,
    isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
  ));
}

/** Live edges whose src is one of these repo memories — the repo memory graph. */
export async function listRepoEdges(db: DB, memoryIds: string[]): Promise<MemoryEdge[]> {
  if (!memoryIds.length) return [];
  return db.select().from(memoryEdges).where(and(
    inArray(memoryEdges.srcMemoryId, memoryIds),
    isNull(memoryEdges.validTo), isNull(memoryEdges.quarantinedAt),
  ));
}

/** Soft-invalidate every live edge touching a memory (called on memory invalidate). */
export async function invalidateEdgesForMemory(db: DB, memoryId: string, now: Date = new Date()): Promise<void> {
  await db.update(memoryEdges).set({ validTo: now }).where(and(
    sql`(${memoryEdges.srcMemoryId} = ${memoryId} or ${memoryEdges.dstMemoryId} = ${memoryId})`,
    isNull(memoryEdges.validTo),
  ));
}

/** Quarantine every live edge an agent authored (mirrors quarantineAgentMemories). */
export async function quarantineAgentEdges(db: DB, agentId: string, now: Date = new Date()): Promise<number> {
  const rows = await db.update(memoryEdges).set({ quarantinedAt: now }).where(and(
    eq(memoryEdges.createdByAgentId, agentId), isNull(memoryEdges.quarantinedAt),
  )).returning({ id: memoryEdges.id });
  return rows.length;
}

/** Lift quarantine on an agent's edges (kill-switch disengage). */
export async function unquarantineAgentEdges(db: DB, agentId: string): Promise<number> {
  const rows = await db.update(memoryEdges).set({ quarantinedAt: null }).where(and(
    eq(memoryEdges.createdByAgentId, agentId), sql`${memoryEdges.quarantinedAt} is not null`,
  )).returning({ id: memoryEdges.id });
  return rows.length;
}
