import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { gitShards, repoShards } from "../models/schema.js";

/**
 * Repo → git-service shard placement.
 *
 * Today the Node API serves git directly from `GIT_REPOS_BASE_PATH`. Phase 3
 * introduces a separate git-service tier (`packages/git-service`) that can
 * scale horizontally. Each repo is pinned to a primary shard (and optionally
 * replicas); the API's git endpoints will forward to the shard's endpoint
 * once the integration is wired in.
 *
 * Until shards exist in the DB, every repo resolves to {@link localShard}
 * which the router treats as "handle in-process exactly like today." This
 * lets us land the data model and helpers without changing the request path
 * for existing deployments.
 */

const LOCAL_SHARD: ShardEndpoint = {
  id: "local",
  endpoint: "local://inprocess",
  role: "primary",
  status: "healthy",
};

export interface ShardEndpoint {
  id: string;
  endpoint: string;
  role: "primary" | "replica";
  status: string;
}

export function consistentShardId(repoId: string, shardIds: string[]): string | null {
  if (!shardIds.length) return null;
  const sorted = [...shardIds].sort();
  let best = sorted[0];
  let bestHash = "";
  for (const s of sorted) {
    const h = createHash("sha256").update(repoId + "|" + s).digest("hex");
    if (h > bestHash) { bestHash = h; best = s; }
  }
  return best;
}

export class ShardMap {
  constructor(private db: DB) {}

  /**
   * Resolve a repo to its primary shard. Returns the synthetic local shard if
   * the repo isn't placed yet — the most common case in development and small
   * single-host deployments.
   */
  async primaryFor(repoId: string): Promise<ShardEndpoint> {
    const row = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!row) return LOCAL_SHARD;
    const shard = (await this.db.select().from(gitShards).where(eq(gitShards.id, row.primaryShardId)).limit(1))[0];
    if (!shard) return LOCAL_SHARD;
    return { id: shard.id, endpoint: shard.endpoint, role: shard.role as ShardEndpoint["role"], status: shard.status };
  }

  async replicasFor(repoId: string): Promise<ShardEndpoint[]> {
    const row = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!row) return [];
    const ids = (row.replicaShardIds as string[] | null) ?? [];
    if (!ids.length) return [];
    const out: ShardEndpoint[] = [];
    for (const id of ids) {
      const s = (await this.db.select().from(gitShards).where(eq(gitShards.id, id)).limit(1))[0];
      if (s) out.push({ id: s.id, endpoint: s.endpoint, role: s.role as ShardEndpoint["role"], status: s.status });
    }
    return out;
  }

  /**
   * Place a freshly-created repo on a shard. Uses rendezvous (HRW) hashing
   * over the set of healthy primary shards so placement is stable and
   * load-balanced without a central rebalancer.
   */
  async placeNew(repoId: string): Promise<ShardEndpoint> {
    const all = await this.db.select().from(gitShards).where(eq(gitShards.status, "healthy"));
    const primaries = all.filter(s => s.role === "primary");
    if (!primaries.length) return LOCAL_SHARD;
    const chosenId = consistentShardId(repoId, primaries.map(s => s.id));
    if (!chosenId) return LOCAL_SHARD;
    const chosen = primaries.find(s => s.id === chosenId)!;
    await this.db.insert(repoShards).values({ repoId, primaryShardId: chosen.id, replicaShardIds: [] })
      .onConflictDoNothing();
    return { id: chosen.id, endpoint: chosen.endpoint, role: "primary", status: chosen.status };
  }
}

export function isLocal(s: ShardEndpoint): boolean {
  return s.id === LOCAL_SHARD.id || s.endpoint === LOCAL_SHARD.endpoint;
}
