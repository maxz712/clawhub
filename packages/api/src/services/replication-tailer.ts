import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards, repositories, repoShards, shardReplicationState } from "../models/schema.js";
import type { GitClientPool } from "./git-client.js";
import { namespaceNameOf, type NamespaceKind } from "./namespace.js";
import { RefLogService } from "./ref-log.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

/**
 * Replication tailer. Runs on every replica shard process.
 *
 * For each repo whose placement lists *this shard* as a replica, the tailer
 * polls `ref_log` from the last applied seq, fetches missing objects from the
 * current primary, applies the refs locally via {@link GitClient.updateRef},
 * and advances `shard_replication_state.last_seq_applied`.
 *
 * The lag is intentionally bounded by Postgres + the `fetch-pack` RPC — we
 * trade a bit of latency (50–500ms typical) for a model that needs no
 * primary→replica streaming protocol.
 *
 * Failure modes:
 *   - Missing object on primary: log + skip (the primary's pack-objects RPC
 *     can't produce a SHA it doesn't have). The tailer's state stays behind
 *     so the failover gating in `shard-watcher` will refuse to promote it.
 *   - Primary unreachable: tick returns early; next tick retries.
 *   - Old ref doesn't match: log + skip; replica's ref state diverged. Mark
 *     status=degraded so operators can re-clone.
 */
export interface ReplicationTailerOptions {
  shardId: string;
  intervalMs?: number;
  batchSize?: number;
}

export class ReplicationTailer {
  private running = false;
  private timer?: NodeJS.Timeout;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly shardId: string;
  private refLogSvc: RefLogService;

  constructor(
    private db: DB,
    private clients: GitClientPool,
    opts: ReplicationTailerOptions,
  ) {
    this.shardId = opts.shardId;
    this.intervalMs = opts.intervalMs ?? 1_500;
    this.batchSize = opts.batchSize ?? 256;
    this.refLogSvc = new RefLogService(db);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.tickOnce(); }
      catch (e) { log("warn", "replication_tick_err", { err: (e as Error).message }); }
      finally { this.timer = setTimeout(tick, this.intervalMs); }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Single replication tick. Exposed for tests. */
  async tickOnce(): Promise<{ reposProcessed: number; entriesApplied: number }> {
    const repoIds = await this.reposThatReplicateHere();
    if (!repoIds.length) return { reposProcessed: 0, entriesApplied: 0 };

    let entriesApplied = 0;
    for (const repoId of repoIds) {
      try {
        const applied = await this.replicateOne(repoId);
        entriesApplied += applied;
      } catch (e) {
        log("warn", "replication_repo_err", { repoId, err: (e as Error).message });
      }
    }
    metrics.inc("clawhub_replication_entries_applied_total", { shard: this.shardId }, entriesApplied);
    return { reposProcessed: repoIds.length, entriesApplied };
  }

  private async replicateOne(repoId: string): Promise<number> {
    const state = (await this.db.select().from(shardReplicationState).where(and(
      eq(shardReplicationState.shardId, this.shardId),
      eq(shardReplicationState.repoId, repoId),
    )).limit(1))[0];
    const since = state?.lastSeqApplied ?? 0;

    const entries = await this.refLogSvc.readSince(repoId, since, this.batchSize);
    if (!entries.length) return 0;

    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) return 0;
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    if (!ns) return 0;

    const placement = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!placement) return 0;

    const selfShard = (await this.db.select().from(gitShards).where(eq(gitShards.id, this.shardId)).limit(1))[0];
    if (!selfShard) return 0;
    const selfClient = this.clients.rpc({ id: selfShard.id, endpoint: selfShard.endpoint, role: "replica", status: selfShard.status });

    let last = since;
    for (const e of entries) {
      // For a delete (newSha all zeros), apply directly.
      if (/^0+$/.test(e.newSha)) {
        try { await selfClient.deleteRef(ns, repo.name, e.refName); } catch { /* may already be deleted */ }
      } else {
        // Object fetch from the entry's writer shard (usually the current primary).
        try {
          const writerShard = (await this.db.select().from(gitShards).where(eq(gitShards.id, e.shardId)).limit(1))[0];
          if (writerShard && writerShard.id !== this.shardId) {
            const src = this.clients.rpc({ id: writerShard.id, endpoint: writerShard.endpoint, role: "primary", status: writerShard.status });
            const pack = await src.fetchPack(ns, repo.name, [e.newSha]);
            await selfClient.applyPack(ns, repo.name, pack);
          }
        } catch (err) {
          log("warn", "replication_fetch_pack_failed", { repoId, sha: e.newSha, err: (err as Error).message });
          await this.markDegraded(repoId, `pack_fetch_failed:${e.newSha}`);
          break; // stop progressing past a known-bad entry
        }
        try { await selfClient.updateRef(ns, repo.name, e.refName, e.oldSha, e.newSha); }
        catch (err) {
          log("warn", "replication_update_ref_failed", { repoId, ref: e.refName, err: (err as Error).message });
          await this.markDegraded(repoId, `update_ref_failed:${e.refName}`);
          break;
        }
      }
      last = e.id;
    }

    await this.db.insert(shardReplicationState).values({
      shardId: this.shardId,
      repoId,
      lastSeqApplied: last,
      lastAppliedAt: new Date(),
      status: "healthy",
      lastError: null,
    }).onConflictDoUpdate({
      target: [shardReplicationState.shardId, shardReplicationState.repoId],
      set: { lastSeqApplied: last, lastAppliedAt: new Date(), status: "healthy", lastError: null },
    });
    metrics.gauge("clawhub_replication_last_seq", { shard: this.shardId, repo: repoId }, last);
    return entries.length;
  }

  private async markDegraded(repoId: string, reason: string): Promise<void> {
    await this.db.insert(shardReplicationState).values({
      shardId: this.shardId,
      repoId,
      lastSeqApplied: 0,
      status: "degraded",
      lastError: reason,
    }).onConflictDoUpdate({
      target: [shardReplicationState.shardId, shardReplicationState.repoId],
      set: { status: "degraded", lastError: reason },
    });
  }

  private async reposThatReplicateHere(): Promise<string[]> {
    const rows = await this.db.select().from(repoShards);
    return rows.filter(r => {
      const ids = (r.replicaShardIds as string[] | null) ?? [];
      return ids.includes(this.shardId);
    }).map(r => r.repoId);
  }

  private async namespaceNameOf(kind: NamespaceKind, id: string): Promise<string | null> {
    return namespaceNameOf(this.db, kind, id);
  }
}
