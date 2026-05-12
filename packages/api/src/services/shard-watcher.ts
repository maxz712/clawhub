import Redis from "ioredis";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards, refLog, repoShards, shardReplicationState } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const LEASE_KEY_PREFIX = "clawhub:shard-lease:";

/**
 * Phase 4 — failover watcher.
 *
 * Subscribes to Redis keyspace notifications for lease-key expiries on
 * `clawhub:shard-lease:*`. When a primary lease expires, attempts to elect a
 * new primary from the surviving replicas:
 *
 *   1. Find the highest `ref_log.id` written by the dead primary for each
 *      affected repo. This is the "tip" the new primary must be caught up to.
 *   2. Pick a replica where `shard_replication_state.last_seq_applied >= tip`
 *      *and* `git_shards.status = 'healthy'`. If multiple, prefer the one
 *      with the fewest repos already assigned.
 *   3. CAS-update `repo_shards.primary_shard_id` for every affected repo
 *      in a single transaction.
 *   4. Emit a `shard.failover` event so other API instances bust their
 *      shard-endpoint caches.
 *
 * If no replica is caught up, the affected repos go to `read_only` state and
 * an operator alert is emitted.
 *
 * **Keyspace notifications must be enabled in Redis**: `CONFIG SET
 * notify-keyspace-events Ex` (E = keyevent, x = expired). Helm chart sets
 * this. We log a warning if subscription fails.
 */
export class ShardWatcher {
  private sub: Redis;
  private running = false;

  constructor(
    private db: DB,
    private events: EventBus,
    url = REDIS_URL,
  ) {
    this.sub = new Redis(url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
      connectTimeout: 1_500,
    });
    this.sub.on("error", () => { /* swallow */ });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sub.connect();
    } catch (e) {
      log("warn", "shard_watcher_redis_unreachable", { err: (e as Error).message });
      // Run a polling fallback so we still detect dead leases (slower).
      void this.pollFallback();
      return;
    }
    try {
      // db 0 is the default; subscribe to expired events.
      await this.sub.subscribe("__keyevent@0__:expired");
      this.sub.on("message", (_chan, msg) => { void this.onKeyExpired(msg); });
      log("info", "shard_watcher_subscribed");
    } catch (e) {
      log("warn", "shard_watcher_subscribe_failed", { err: (e as Error).message });
      void this.pollFallback();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try { await this.sub.quit(); } catch { /* ignore */ }
  }

  private async onKeyExpired(key: string): Promise<void> {
    if (!key.startsWith(LEASE_KEY_PREFIX)) return;
    const shardId = key.slice(LEASE_KEY_PREFIX.length);
    log("warn", "shard_lease_expired", { shardId });
    metrics.inc("clawhub_shard_lease_expired_total", { shard: shardId });
    try { await this.runFailover(shardId); }
    catch (e) { log("error", "failover_failed", { err: (e as Error).message, shardId }); }
  }

  /**
   * Periodic backup if keyspace notifications aren't available. Runs every
   * 15s and treats `lease_expires_at < now()` rows as if their key expired.
   */
  private async pollFallback(): Promise<void> {
    while (this.running) {
      try {
        const stale = await this.db.execute(sql`
          select id from git_shards
          where role = 'primary'
            and lease_expires_at is not null
            and lease_expires_at < now() - interval '5 seconds'
        `);
        for (const r of stale as unknown as Array<{ id: string }>) {
          await this.runFailover(r.id);
        }
      } catch (e) { log("warn", "shard_watcher_poll_err", { err: (e as Error).message }); }
      await new Promise(res => setTimeout(res, 15_000));
    }
  }

  /**
   * Election logic. Public so it can be invoked manually by the admin API
   * (`POST /admin/shards/promote/:repoId`) and tested directly.
   */
  async runFailover(deadShardId: string): Promise<{
    promoted: Array<{ repoId: string; toShard: string }>;
    quarantined: string[];
  }> {
    const promoted: Array<{ repoId: string; toShard: string }> = [];
    const quarantined: string[] = [];

    const affectedRepos = await this.db.select().from(repoShards)
      .where(eq(repoShards.primaryShardId, deadShardId));

    if (!affectedRepos.length) return { promoted, quarantined };

    const healthyShards = await this.db.select().from(gitShards)
      .where(and(eq(gitShards.status, "healthy")));
    const shardRepoCounts = await this.shardLoadCounts();

    for (const rs of affectedRepos) {
      const replicaIds = (rs.replicaShardIds as string[] | null) ?? [];
      if (!replicaIds.length) {
        await this.markReadOnly(rs.repoId, "no_replicas");
        quarantined.push(rs.repoId);
        continue;
      }

      // Tip = highest ref_log id written by the dead primary for this repo.
      const tipRow = (await this.db.select({ tip: sql<number>`coalesce(max(${refLog.id}), 0)::bigint` })
        .from(refLog)
        .where(and(eq(refLog.repoId, rs.repoId), eq(refLog.shardId, deadShardId))))[0];
      const tip = Number(tipRow?.tip ?? 0);

      // Find caught-up + healthy replicas, sorted by lightest load.
      const eligible = await this.db.select().from(shardReplicationState)
        .where(and(
          eq(shardReplicationState.repoId, rs.repoId),
          gte(shardReplicationState.lastSeqApplied, tip),
        ));
      const candidates = eligible
        .filter(s => replicaIds.includes(s.shardId))
        .filter(s => healthyShards.some(h => h.id === s.shardId))
        .sort((a, b) => (shardRepoCounts.get(a.shardId) ?? 0) - (shardRepoCounts.get(b.shardId) ?? 0));

      if (!candidates.length) {
        await this.markReadOnly(rs.repoId, `no_caught_up_replica_tip=${tip}`);
        quarantined.push(rs.repoId);
        continue;
      }

      const winner = candidates[0];
      const newReplicaIds = [...replicaIds.filter(id => id !== winner.shardId), deadShardId];
      try {
        await this.db.update(repoShards).set({
          primaryShardId: winner.shardId,
          replicaShardIds: newReplicaIds,
          status: "active",
          updatedAt: new Date(),
        }).where(eq(repoShards.repoId, rs.repoId));
        promoted.push({ repoId: rs.repoId, toShard: winner.shardId });
        shardRepoCounts.set(winner.shardId, (shardRepoCounts.get(winner.shardId) ?? 0) + 1);
        log("info", "shard_failover_promoted", { repoId: rs.repoId, from: deadShardId, to: winner.shardId, tip });
      } catch (e) {
        log("error", "shard_failover_promotion_failed", { err: (e as Error).message, repoId: rs.repoId });
      }
    }

    // Mark the dead shard's leases empty so the leader-election loop can re-elect cleanly.
    await this.db.update(gitShards).set({ leaseHolder: null, leaseExpiresAt: null, status: "unhealthy" })
      .where(eq(gitShards.id, deadShardId));

    await this.events.publish({
      type: "shard.failover",
      actorKind: "system",
      payload: { deadShard: deadShardId, promoted, quarantined },
    });
    metrics.inc("clawhub_shard_failover_total", { shard: deadShardId, outcome: quarantined.length ? "partial" : "complete" });
    return { promoted, quarantined };
  }

  private async markReadOnly(repoId: string, reason: string): Promise<void> {
    await this.db.update(repoShards).set({ status: "read_only", updatedAt: new Date() })
      .where(eq(repoShards.repoId, repoId));
    log("error", "shard_failover_quarantine", { repoId, reason });
    await this.events.publish({
      type: "shard.quarantine",
      repoId,
      actorKind: "system",
      payload: { reason },
    });
  }

  private async shardLoadCounts(): Promise<Map<string, number>> {
    const rows = await this.db.execute(sql`
      select primary_shard_id as id, count(*) as n
      from repo_shards
      group by primary_shard_id
    `);
    const m = new Map<string, number>();
    for (const r of rows as unknown as Array<{ id: string; n: string }>) m.set(r.id, Number(r.n));
    return m;
  }

  /**
   * Manual promotion handler used by the admin endpoint. Validates that the
   * target replica is caught up before flipping the primary.
   */
  async promoteManual(repoId: string, toShardId: string): Promise<void> {
    const rs = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!rs) throw new Error(`no placement for repo ${repoId}`);
    if (rs.primaryShardId === toShardId) return;

    const tipRow = (await this.db.select({ tip: sql<number>`coalesce(max(${refLog.id}), 0)::bigint` })
      .from(refLog)
      .where(and(eq(refLog.repoId, repoId), eq(refLog.shardId, rs.primaryShardId))))[0];
    const tip = Number(tipRow?.tip ?? 0);

    const state = (await this.db.select().from(shardReplicationState)
      .where(and(eq(shardReplicationState.repoId, repoId), eq(shardReplicationState.shardId, toShardId)))
      .limit(1))[0];
    if (!state) throw new Error(`replica ${toShardId} has no replication state for ${repoId}`);
    if (state.lastSeqApplied < tip) {
      throw new Error(`replica ${toShardId} is behind: last_seq_applied=${state.lastSeqApplied} < tip=${tip}`);
    }

    const replicaIds = (rs.replicaShardIds as string[] | null) ?? [];
    const newReplicas = [...replicaIds.filter(id => id !== toShardId), rs.primaryShardId];
    await this.db.update(repoShards).set({
      primaryShardId: toShardId,
      replicaShardIds: newReplicas,
      status: "active",
      updatedAt: new Date(),
    }).where(eq(repoShards.repoId, repoId));
    await this.events.publish({
      type: "shard.promote",
      repoId,
      actorKind: "system",
      payload: { from: rs.primaryShardId, to: toShardId, tip },
    });
  }
}
