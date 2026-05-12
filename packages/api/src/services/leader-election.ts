import { hostname } from "node:os";
import Redis from "ioredis";
import { eq, lt, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards } from "../models/schema.js";
import { log } from "./logger.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Redis lease for per-shard primary election. Phase 4 scaffold — a real
 * deployment will combine this with a follower that streams ref updates
 * from the primary; today we only run the lease loop and reflect lease
 * ownership into the `git_shards` table.
 *
 * The contract: at any time only one process holds the lease for a given
 * shard ID, identified by `holder`. The holder renews every `renewMs` and
 * the lease expires `ttlMs` after the last successful renew. If the holder
 * crashes, a follower acquires the lease in at most `ttlMs - renewMs`.
 */
export class ShardLeaseManager {
  private client: Redis;
  private holder: string;
  private ttlMs: number;
  private renewMs: number;
  private heldShards = new Map<string, NodeJS.Timeout>();

  constructor(opts: { holder?: string; ttlMs?: number; renewMs?: number } = {}, url = REDIS_URL) {
    this.client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    this.holder = opts.holder ?? `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.ttlMs = opts.ttlMs ?? 15_000;
    this.renewMs = opts.renewMs ?? 5_000;
  }

  get id(): string { return this.holder; }

  async tryAcquire(shardId: string): Promise<boolean> {
    await this.client.connect().catch(() => {});
    const key = `clawhub:shard-lease:${shardId}`;
    let ok: "OK" | null = null;
    try { ok = await this.client.set(key, this.holder, "PX", this.ttlMs, "NX") as "OK" | null; }
    catch (e) { log("warn", "shard_lease_set_failed", { err: (e as Error).message }); return false; }
    if (ok !== "OK") return false;
    const timer = setInterval(() => { void this.renew(shardId); }, this.renewMs);
    this.heldShards.set(shardId, timer);
    return true;
  }

  private async renew(shardId: string): Promise<void> {
    const key = `clawhub:shard-lease:${shardId}`;
    try {
      // Use PEXPIRE only if the value matches (compare-and-extend) — pipe two ops.
      const owned = await this.client.get(key);
      if (owned !== this.holder) {
        log("warn", "shard_lease_lost", { shardId, holder: this.holder });
        const t = this.heldShards.get(shardId); if (t) clearInterval(t);
        this.heldShards.delete(shardId);
        return;
      }
      await this.client.pexpire(key, this.ttlMs);
    } catch (e) {
      log("warn", "shard_lease_renew_failed", { err: (e as Error).message });
    }
  }

  async release(shardId: string): Promise<void> {
    const t = this.heldShards.get(shardId);
    if (t) clearInterval(t);
    this.heldShards.delete(shardId);
    try { await this.client.eval(RELEASE_LUA, 1, `clawhub:shard-lease:${shardId}`, this.holder); }
    catch { /* TTL will release */ }
  }

  async close(): Promise<void> {
    for (const id of [...this.heldShards.keys()]) await this.release(id);
    await this.client.quit().catch(() => undefined);
  }
}

/**
 * Reflect the Redis lease into the `git_shards.lease_holder` column for
 * observability. Other API processes can read this to know which shard each
 * primary lives on. Called periodically from a sidecar / cron tick.
 */
export async function reflectLeaseToDb(db: DB, shardId: string, holder: string, ttlMs: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.update(gitShards).set({ leaseHolder: holder, leaseExpiresAt: expiresAt })
    .where(eq(gitShards.id, shardId));
}

/** Reap stale lease rows whose TTL has elapsed by more than a grace period. */
export async function reapStaleLeases(db: DB, graceMs = 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - graceMs);
  const updated = await db.update(gitShards)
    .set({ leaseHolder: null, leaseExpiresAt: null })
    .where(or(lt(gitShards.leaseExpiresAt, cutoff), eq(gitShards.status, "draining")))
    .returning();
  return updated.length;
}
