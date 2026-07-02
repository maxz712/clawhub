/**
 * Memory-usefulness eval — run it against a live DB to answer "is memory
 * earning its tokens for this repo?" with numbers instead of vibes.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/memory-eval.ts <ns>/<repo>
 *
 * Reports, per repo:
 *  1. INVENTORY  — live memories by kind/scope, pending backlog, facts coverage
 *     (paths / fingerprints / changeIds — the grounding that powers retrieval).
 *  2. USAGE      — use_count distribution: what fraction of memories has ever
 *     been retrieved/cited (the Codex signal: uncited memories are dead weight).
 *  3. CONDITIONING A/B — for the N most recent changes, build the pack twice
 *     (generic vs diff-conditioned) and measure how many pack slots are
 *     path-relevant to that change's diff in each. The delta is what P0's
 *     changedPaths wiring buys on this repo's real history.
 *  4. GRAPH      — edge counts by origin/relation (a zero here means the graph
 *     leg contributes nothing).
 *
 * Read-only. No LLM. Exit code 0 always (it's a report, not a gate).
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/models/schema.js";
import { agentMemories, changes, memoryEdges, repositories } from "../src/models/schema.js";
import { buildMemoryPack, resolveScopeIds } from "../src/services/memory.js";
import { resolveNamespace } from "../src/services/namespace.js";

const [nsName, repoName] = (process.argv[2] ?? "").split("/");
if (!nsName || !repoName) {
  console.error("usage: npx tsx scripts/memory-eval.ts <ns>/<repo>");
  process.exit(1);
}

const client = postgres(process.env.DATABASE_URL ?? "postgresql://clawhub:clawhub@localhost:5432/clawhub", { max: 2 });
const db = drizzle(client, { schema });

const ns = await resolveNamespace(db, nsName);
if (!ns) { console.error(`namespace not found: ${nsName}`); process.exit(1); }
const repo = (await db.select().from(repositories).where(and(eq(repositories.namespaceId, ns.id), eq(repositories.name, repoName))).limit(1))[0];
if (!repo) { console.error(`repo not found: ${nsName}/${repoName}`); process.exit(1); }

// --- 1. inventory ------------------------------------------------------------
const live = await db.select().from(agentMemories).where(and(
  eq(agentMemories.repoId, repo.id), isNull(agentMemories.validTo),
  isNull(agentMemories.archivedAt), isNull(agentMemories.quarantinedAt),
));
const byKind = new Map<string, number>();
let withPaths = 0, withFp = 0, withChange = 0, pending = 0;
for (const m of live) {
  byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
  const f = m.facts as { paths?: unknown[]; errorFingerprint?: string; changeId?: string };
  if (Array.isArray(f?.paths) && f.paths.length) withPaths++;
  if (f?.errorFingerprint) withFp++;
  if (f?.changeId) withChange++;
  if (m.pendingAt) pending++;
}
console.log(`\n=== memory eval: ${nsName}/${repoName} ===`);
console.log(`\n[1] INVENTORY — ${live.length} live memories`);
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(11)} ${n}`);
const pct = (n: number) => live.length ? `${Math.round((n / live.length) * 100)}%` : "n/a";
console.log(`    grounding: paths ${pct(withPaths)}, fingerprint ${pct(withFp)}, changeId ${pct(withChange)}; pending approval: ${pending}`);

// --- 2. usage ---------------------------------------------------------------
const used = live.filter(m => m.useCount > 0);
const topUsed = [...live].sort((a, b) => b.useCount - a.useCount).slice(0, 5);
console.log(`\n[2] USAGE — ${used.length}/${live.length} ever retrieved/cited (${pct(used.length)})`);
for (const m of topUsed) console.log(`    ${String(m.useCount).padStart(3)}x  [${m.kind}] ${m.title.slice(0, 70)}`);

// --- 3. conditioning A/B ------------------------------------------------------
const recent = await db.select().from(changes)
  .where(eq(changes.repoId, repo.id)).orderBy(desc(changes.updatedAt)).limit(10);
// Evaluate as the repo's most prolific authoring agent (or platform scope).
const agentId = live.find(m => m.createdByAgentId)?.createdByAgentId ?? null;
const ids = agentId ? await resolveScopeIds(db, agentId, repo.id) : { agentId: null, repoId: repo.id, orgId: null };
const pathsOf = (m: { facts: unknown }): string[] => {
  const p = (m.facts as { paths?: unknown })?.paths;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
};
const related = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
let genericHits = 0, conditionedHits = 0, slots = 0, evaluated = 0;
for (const ch of recent) {
  const diff = Array.isArray(ch.changedPaths) ? (ch.changedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  if (!diff.length) continue;
  evaluated++;
  const packOf = async (cond: boolean) =>
    (JSON.parse(await buildMemoryPack(db, ids, cond ? { changedPaths: diff } : {})) as { memories: Array<{ facts: unknown }> }).memories;
  const relevant = (ms: Array<{ facts: unknown }>) =>
    ms.filter(m => pathsOf(m).some(p => diff.some(d => related(d, p)))).length;
  const g = await packOf(false), c = await packOf(true);
  genericHits += relevant(g); conditionedHits += relevant(c); slots += Math.max(g.length, c.length);
}
console.log(`\n[3] CONDITIONING A/B — over ${evaluated} recent changes with diffs`);
console.log(`    diff-relevant pack entries: generic ${genericHits}  vs  conditioned ${conditionedHits}  (of ~${slots} slots)`);

// --- 4. graph -----------------------------------------------------------------
const edges = await db.select({ origin: memoryEdges.origin, relation: memoryEdges.relation, n: sql<number>`count(*)::int` })
  .from(memoryEdges)
  .where(and(eq(memoryEdges.repoId, repo.id), isNull(memoryEdges.validTo)))
  .groupBy(memoryEdges.origin, memoryEdges.relation);
console.log(`\n[4] GRAPH — live edges`);
if (!edges.length) console.log("    (none — the graph leg contributes nothing on this repo)");
for (const e of edges) console.log(`    ${e.origin.padEnd(8)} ${e.relation.padEnd(11)} ${e.n}`);
console.log();
await client.end();
