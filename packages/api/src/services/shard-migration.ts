import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards, refLog, repoMigrations, repoShards, repositories, shardReplicationState } from "../models/schema.js";
import type { GitClientPool } from "./git-client.js";
import { withRepoLock } from "./repo-lock.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";
import { resolveNamespace } from "./repo-resolver.js";

/**
 * Resumable repo migration between shards.
 *
 * State machine:
 *   queued → cloning → tailing → cutover → cleanup → done
 *                                       └→ failed (terminal)
 *
 *   - **cloning**: dest shard mirror-clones from source.
 *   - **tailing**: dest replays `ref_log` entries since `last_seq_applied`,
 *     stops when caught up to within `cutoverLagMax` entries.
 *   - **cutover**: acquire per-repo lock, recompute the source's tip,
 *     replay anything new, then atomically flip `repo_shards.primary_shard_id`.
 *   - **cleanup**: dest persists its `shard_replication_state.last_seq_applied`;
 *     source garbage-collects the local repo on its next sweep (delayed 24h).
 *
 * Idempotent at every step — interrupt and re-run any time. Each step is
 * gated by reading the current `state` and only advancing if it matches.
 */
export class ShardMigrationService {
  constructor(
    private db: DB,
    private clients: GitClientPool,
  ) {}

  /** Enqueue a new migration. Idempotent: a `queued|cloning|tailing|cutover` migration for the same repo returns the existing row. */
  async enqueue(repoId: string, toShardId: string): Promise<{ id: string; existing: boolean }> {
    const inflight = (await this.db.select().from(repoMigrations).where(and(
      eq(repoMigrations.repoId, repoId),
      sql`${repoMigrations.state} in ('queued','cloning','tailing','cutover')`,
    )).limit(1))[0];
    if (inflight) return { id: inflight.id, existing: true };

    const rs = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!rs) throw new Error(`repo ${repoId} has no shard placement`);
    if (rs.primaryShardId === toShardId) throw new Error(`repo ${repoId} already on shard ${toShardId}`);

    const ins = await this.db.insert(repoMigrations).values({
      repoId,
      fromShardId: rs.primaryShardId,
      toShardId,
      state: "queued",
    }).returning();
    return { id: ins[0].id, existing: false };
  }

  /** Drive a single migration to completion or failure. Safe to call multiple times. */
  async run(migrationId: string): Promise<void> {
    const m = (await this.db.select().from(repoMigrations).where(eq(repoMigrations.id, migrationId)).limit(1))[0];
    if (!m) throw new Error(`migration ${migrationId} not found`);
    if (m.state === "done" || m.state === "failed") return;

    try {
      if (m.state === "queued") await this.transition(migrationId, "queued", "cloning", { startedAt: new Date() });
      if ((await this.stateOf(migrationId)) === "cloning") await this.runCloning(migrationId);
      if ((await this.stateOf(migrationId)) === "tailing") await this.runTailing(migrationId);
      if ((await this.stateOf(migrationId)) === "cutover") await this.runCutover(migrationId);
      if ((await this.stateOf(migrationId)) === "cleanup") await this.runCleanup(migrationId);
    } catch (e) {
      const err = (e as Error).message;
      await this.db.update(repoMigrations).set({ state: "failed", error: err, updatedAt: new Date(), completedAt: new Date() })
        .where(eq(repoMigrations.id, migrationId));
      log("error", "migration_failed", { migrationId, err });
      metrics.inc("clawhub_shard_migration_total", { outcome: "failed" });
      throw e;
    }
  }

  private async runCloning(migrationId: string): Promise<void> {
    const m = await this.mustGet(migrationId);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, m.repoId)).limit(1))[0];
    if (!repo) throw new Error(`repo ${m.repoId} missing`);
    const ns = await resolveNamespace(this.db, "" /* lookup via repo */) || await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    const namespace = typeof ns === "string" ? ns : ns?.name ?? "unknown";

    const fromShard = await this.requireShard(m.fromShardId);
    const toShard = await this.requireShard(m.toShardId);

    const destClient = this.clients.get({ id: toShard.id, endpoint: toShard.endpoint, role: "primary", status: toShard.status });
    await destClient.mirrorClone({ namespace, name: repo.name, fromEndpoint: fromShard.endpoint });
    log("info", "migration_clone_complete", { migrationId, repoId: m.repoId });
    await this.transition(migrationId, "cloning", "tailing");
  }

  private async runTailing(migrationId: string, opts: { cutoverLagMax?: number; maxIterations?: number } = {}): Promise<void> {
    const cutoverLagMax = opts.cutoverLagMax ?? 5;
    const maxIters = opts.maxIterations ?? 100;
    const m = await this.mustGet(migrationId);

    for (let i = 0; i < maxIters; i++) {
      const tip = await this.refLogTip(m.repoId);
      const applied = m.lastSeqApplied;
      if (tip - applied <= cutoverLagMax) {
        await this.transition(migrationId, "tailing", "cutover");
        return;
      }
      const fresh = await this.applyRefLogRange(m.repoId, m.toShardId, applied, 256);
      await this.db.update(repoMigrations).set({ lastSeqApplied: fresh.appliedThrough, updatedAt: new Date() })
        .where(eq(repoMigrations.id, migrationId));
      m.lastSeqApplied = fresh.appliedThrough;
      if (fresh.applied === 0) {
        await new Promise(r => setTimeout(r, 500)); // brief wait if nothing new
      }
    }
    // Many iterations and still behind — leave state, run() will resume next call.
  }

  private async runCutover(migrationId: string): Promise<void> {
    const m = await this.mustGet(migrationId);
    await withRepoLock(m.repoId, async () => {
      // Drain any final ref_log entries.
      const tip = await this.refLogTip(m.repoId);
      if (tip > m.lastSeqApplied) {
        const r = await this.applyRefLogRange(m.repoId, m.toShardId, m.lastSeqApplied, tip - m.lastSeqApplied);
        await this.db.update(repoMigrations).set({ lastSeqApplied: r.appliedThrough, updatedAt: new Date() })
          .where(eq(repoMigrations.id, migrationId));
      }
      // Flip placement.
      const rs = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, m.repoId)).limit(1))[0];
      if (!rs) throw new Error("placement disappeared mid-migration");
      const newReplicas = [...((rs.replicaShardIds as string[] | null) ?? []).filter(id => id !== m.toShardId), m.fromShardId];
      await this.db.update(repoShards).set({
        primaryShardId: m.toShardId,
        replicaShardIds: newReplicas,
        status: "active",
        updatedAt: new Date(),
      }).where(eq(repoShards.repoId, m.repoId));
    }, { kind: "migration-cutover", ttlMs: 60_000, waitMs: 30_000 });
    await this.transition(migrationId, "cutover", "cleanup");
  }

  private async runCleanup(migrationId: string): Promise<void> {
    const m = await this.mustGet(migrationId);
    // Persist final replication state for the new primary.
    await this.db.insert(shardReplicationState).values({
      shardId: m.toShardId,
      repoId: m.repoId,
      lastSeqApplied: m.lastSeqApplied,
      lastAppliedAt: new Date(),
      status: "healthy",
    }).onConflictDoUpdate({
      target: [shardReplicationState.shardId, shardReplicationState.repoId],
      set: { lastSeqApplied: m.lastSeqApplied, lastAppliedAt: new Date(), status: "healthy", lastError: null },
    });
    await this.db.update(repoMigrations).set({ state: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(repoMigrations.id, migrationId));
    metrics.inc("clawhub_shard_migration_total", { outcome: "done" });
    log("info", "migration_done", { migrationId });
  }

  /**
   * Pull a range of `ref_log` entries and apply them to the destination shard.
   * Returns the count actually applied and the new high-watermark.
   */
  private async applyRefLogRange(repoId: string, toShardId: string, since: number, limit: number): Promise<{ applied: number; appliedThrough: number }> {
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) throw new Error("repo missing");
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    const shard = await this.requireShard(toShardId);
    const client = this.clients.get({ id: shard.id, endpoint: shard.endpoint, role: "primary", status: shard.status });

    const entries = await this.db.select().from(refLog).where(and(eq(refLog.repoId, repoId), sql`${refLog.id} > ${since}`))
      .orderBy(refLog.id).limit(limit);
    if (!entries.length) return { applied: 0, appliedThrough: since };

    let highWater = since;
    for (const e of entries) {
      if (/^0+$/.test(e.newSha)) {
        try { await client.deleteRef(ns, repo.name, e.refName); } catch (err) { /* best-effort */ log("warn", "migration_delete_ref_failed", { err: (err as Error).message, repoId, ref: e.refName }); }
      } else {
        // Fetch missing objects from current source, then apply.
        try {
          const sourceShard = (await this.db.select().from(gitShards).where(eq(gitShards.id, e.shardId)).limit(1))[0];
          if (sourceShard) {
            const srcClient = this.clients.get({ id: sourceShard.id, endpoint: sourceShard.endpoint, role: "primary", status: sourceShard.status });
            const pack = await srcClient.fetchPack(ns, repo.name, [e.newSha]);
            await client.applyPack(ns, repo.name, pack);
          }
        } catch (err) { log("warn", "migration_pack_fetch_failed", { err: (err as Error).message, repoId, sha: e.newSha }); }
        try { await client.updateRef(ns, repo.name, e.refName, e.oldSha, e.newSha); }
        catch (err) {
          log("warn", "migration_update_ref_failed", { err: (err as Error).message, repoId, ref: e.refName });
        }
      }
      highWater = e.id;
    }
    return { applied: entries.length, appliedThrough: highWater };
  }

  private async refLogTip(repoId: string): Promise<number> {
    const r = await this.db.execute(sql`select coalesce(max(id), 0)::bigint as tip from ref_log where repo_id = ${repoId}`);
    const row = (r as unknown as Array<{ tip: string | number }>)[0];
    return Number(row?.tip ?? 0);
  }

  private async stateOf(id: string): Promise<string> {
    const r = (await this.db.select({ s: repoMigrations.state }).from(repoMigrations).where(eq(repoMigrations.id, id)).limit(1))[0];
    return r?.s ?? "";
  }

  private async mustGet(id: string) {
    const r = (await this.db.select().from(repoMigrations).where(eq(repoMigrations.id, id)).limit(1))[0];
    if (!r) throw new Error("migration vanished");
    return r;
  }

  private async transition(id: string, from: string, to: string, extra: Partial<{ startedAt: Date }> = {}): Promise<void> {
    const r = await this.db.update(repoMigrations).set({
      state: to,
      ...extra,
      updatedAt: new Date(),
    }).where(and(eq(repoMigrations.id, id), eq(repoMigrations.state, from))).returning();
    if (!r.length) {
      const cur = await this.stateOf(id);
      if (cur !== to) throw new Error(`failed to transition ${from} → ${to} (current=${cur})`);
    }
  }

  private async requireShard(shardId: string) {
    const s = (await this.db.select().from(gitShards).where(eq(gitShards.id, shardId)).limit(1))[0];
    if (!s) throw new Error(`shard ${shardId} not found`);
    return s;
  }

  private async namespaceNameOf(kind: "agent" | "org", id: string): Promise<string> {
    const { agents, organizations } = await import("../models/schema.js");
    if (kind === "agent") {
      const a = (await this.db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
      return a?.name ?? "unknown";
    }
    const o = (await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0];
    return o?.name ?? "unknown";
  }
}
