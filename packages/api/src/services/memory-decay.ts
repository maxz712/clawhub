import { and, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, killSwitches } from "../models/schema.js";
import { deriveCoChangeEdges, deriveEdgesForRepo } from "./memory-graph.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// Cap repos re-derived per sweep (bounded, idempotent). Edges of hard-pruned
// memories cascade-delete via FK, so decay needs no explicit edge cleanup — only
// this forward refresh (fingerprint clusters + facts.paths → about materialization).
const MAX_DERIVE_REPOS = Number(process.env.CLAWHUB_MEMORY_DERIVE_REPOS_PER_SWEEP ?? 200);

// Memory decay — ClawHub's one autonomous memory job. Deterministic, no model.
// Usage is the survival signal: reads refresh lastUsedAt (services/memory.ts),
// so a never-re-read memory ages out while a used one stays. Conservative:
// soft-archive (recoverable) before hard-prune, and never touch pinned/decision
// rows. See docs/memory.md.

const DAY = 24 * 3600_000;
// Half-life by kind: how long an UNUSED memory survives before it's archived.
const ARCHIVE_AFTER_DAYS: Record<string, number> = {
  episode: 21,      // episodic noise ages fast
  failure: 120,
  convention: 240,
  decision: 3650,   // effectively never (also protected below)
  expertise: 180,
};
const PRUNE_ARCHIVED_AFTER_DAYS = 30; // grace after archive before hard delete
const PRUNE_SUPERSEDED_AFTER_DAYS = 30;
const PRUNE_QUARANTINED_AFTER_DAYS = 30; // quarantined rows hard-deleted after this

/** Run one decay pass. Returns {archived, pruned}. Exposed for tests. */
export async function runMemoryDecaySweep(db: DB, now: Date = new Date()): Promise<{ archived: number; pruned: number }> {
  let archived = 0;
  let pruned = 0;

  // 1. Archive stale, unused, live memories (not pinned, not decisions). A read
  //    would have refreshed lastUsedAt, so only genuinely-cold rows match.
  for (const [kind, days] of Object.entries(ARCHIVE_AFTER_DAYS)) {
    if (kind === "decision") continue; // decisions don't decay
    const cutoff = new Date(now.getTime() - days * DAY);
    const rows = await db.update(agentMemories)
      .set({ archivedAt: now })
      .where(and(
        eq(agentMemories.kind, kind as typeof agentMemories.$inferSelect.kind),
        isNull(agentMemories.validTo),
        isNull(agentMemories.archivedAt),
        eq(agentMemories.pinned, false),
        lt(agentMemories.lastUsedAt, cutoff),
        eq(agentMemories.useCount, 0),
      )).returning({ id: agentMemories.id });
    archived += rows.length;
  }

  // 2. Hard-prune: archived rows past the grace window, superseded rows past the
  //    audit window, expired (TTL) rows, and long-quarantined rows. Pinned rows
  //    are never pruned; decisions are exempt from TTL ("decisions never decay").
  const archivePrune = new Date(now.getTime() - PRUNE_ARCHIVED_AFTER_DAYS * DAY);
  const supersedePrune = new Date(now.getTime() - PRUNE_SUPERSEDED_AFTER_DAYS * DAY);
  const quarantinePrune = new Date(now.getTime() - PRUNE_QUARANTINED_AFTER_DAYS * DAY);
  const expired = await db.delete(agentMemories)
    .where(and(eq(agentMemories.pinned, false), isNotNull(agentMemories.archivedAt), lt(agentMemories.archivedAt, archivePrune)))
    .returning({ id: agentMemories.id });
  const sup = await db.delete(agentMemories)
    .where(and(eq(agentMemories.pinned, false), isNotNull(agentMemories.validTo), lt(agentMemories.validTo, supersedePrune)))
    .returning({ id: agentMemories.id });
  const ttl = await db.delete(agentMemories)
    .where(and(eq(agentMemories.pinned, false), ne(agentMemories.kind, "decision"), isNotNull(agentMemories.expiresAt), lt(agentMemories.expiresAt, now)))
    .returning({ id: agentMemories.id });
  // Quarantined rows are an INVESTIGATIVE HOLD, not a TTL. Engaging an agent's
  // kill-switch stamps quarantinedAt; disengaging it clears the stamp
  // (services/kill-switch.ts engage/disengage → un/quarantineAgentMemories). So a
  // row may be hard-deleted only once its owning agent's kill-switch has been
  // DISENGAGED — while the switch stays engaged the quarantine is an ACTIVE
  // incident hold and its evidence must be preserved indefinitely, not auto-shred
  // after 30 days (an unrelated circuit-breaker auto-pause could otherwise destroy
  // an in-flight investigation's records). This matches docs/memory.md: quarantined
  // rows are hard-deleted "only via GDPR / kill-switch" — an explicit action, never
  // a time-based sweep. A null owner (agent deleted) has no active hold, so it stays
  // eligible. See #91.
  const quarCandidates = await db.select({ id: agentMemories.id, agentId: agentMemories.createdByAgentId })
    .from(agentMemories)
    .where(and(eq(agentMemories.pinned, false), isNotNull(agentMemories.quarantinedAt), lt(agentMemories.quarantinedAt, quarantinePrune)));
  const candidateAgentIds = [...new Set(quarCandidates.map(r => r.agentId).filter((x): x is string => !!x))];
  const stillKilled = candidateAgentIds.length
    ? new Set((await db.select({ agentId: killSwitches.agentId }).from(killSwitches).where(inArray(killSwitches.agentId, candidateAgentIds))).map(r => r.agentId))
    : new Set<string>();
  const prunableQuarIds = quarCandidates.filter(r => !r.agentId || !stillKilled.has(r.agentId)).map(r => r.id);
  const quar = prunableQuarIds.length
    ? await db.delete(agentMemories).where(inArray(agentMemories.id, prunableQuarIds)).returning({ id: agentMemories.id })
    : [];
  pruned = expired.length + sup.length + ttl.length + quar.length;

  if (archived || pruned) {
    metrics.inc("clawhub_memory_archived_total", {}, archived);
    metrics.inc("clawhub_memory_pruned_total", {}, pruned);
    log("info", "memory_decay_sweep", { archived, pruned });
  }

  // Refresh mechanical graph edges (deterministic, idempotent). Bounded + best-effort
  // so a slow/failing derive never stalls the decay loop. deriveEdgesForRepo already
  // meters the derived-edge count.
  try {
    const repos = await db.selectDistinct({ repoId: agentMemories.repoId }).from(agentMemories)
      .where(and(isNotNull(agentMemories.repoId), isNull(agentMemories.validTo)));
    for (const { repoId } of repos.slice(0, MAX_DERIVE_REPOS)) {
      if (repoId) {
        await deriveEdgesForRepo(db, repoId);
        // Co-change coupling from merged-change history: memories about path A
        // surface when a diff touches its frequent co-change partner B.
        await deriveCoChangeEdges(db, repoId);
      }
    }
  } catch (e) {
    log("warn", "memory_edge_derive_failed", { err: (e as Error).message });
  }

  // Gauge: live memory rows, for storage-growth visibility.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(agentMemories).where(isNull(agentMemories.validTo));
  metrics.gauge("clawhub_memory_rows", {}, Number(n ?? 0));
  return { archived, pruned };
}

/** Start the decay loop. Returns a stop function. Timer is unref'd (like the reaper). */
export function startMemoryDecaySweep(db: DB, intervalMs = 3600_000): () => void {
  const timer = setInterval(() => {
    runMemoryDecaySweep(db).catch(e => log("warn", "memory_decay_failed", { err: (e as Error).message }));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
