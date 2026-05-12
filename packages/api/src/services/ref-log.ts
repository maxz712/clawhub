import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { refLog, type RefLogEntry } from "../models/schema.js";

/**
 * Phase 4 — Postgres-as-WAL for refs.
 *
 * The receive-pack flow on the primary shard calls {@link appendRefUpdate}
 * **before** applying the ref locally. If the insert fails (Postgres down,
 * constraint violation, etc.) the push is rejected upstream. Replicas tail
 * {@link readSince} to apply ref changes locally.
 *
 * Why Postgres and not Redis Streams or a separate WAL: refs are tiny but
 * load-bearing for the merge model. Postgres gives us ACID + the existing
 * `ref_log_repo_idx` for cheap "give me everything since seq N" reads.
 *
 * The internal HTTP endpoint that shards call is `POST /api/v1/internal/ref-log`
 * (see `routes/internal.ts`). The HMAC scheme is intentionally simple — both
 * sides share `CLAWHUB_INTERNAL_TOKEN`, signed body + timestamp.
 */
export interface RefUpdate {
  refName: string;
  oldSha: string;
  newSha: string;
  shardId: string;
  agentId?: string | null;
}

export class RefLogService {
  constructor(private db: DB) {}

  async appendRefUpdate(repoId: string, u: RefUpdate): Promise<RefLogEntry> {
    const rows = await this.db.insert(refLog).values({
      repoId,
      refName: u.refName,
      oldSha: u.oldSha,
      newSha: u.newSha,
      shardId: u.shardId,
      agentId: u.agentId ?? null,
    }).returning();
    return rows[0];
  }

  /**
   * Apply many ref updates in a single transaction. Used by the receive-pack
   * pre-receive hook: either all refs in the push land in the WAL or none do.
   */
  async appendBatch(repoId: string, updates: RefUpdate[]): Promise<RefLogEntry[]> {
    if (!updates.length) return [];
    return this.db.transaction(async tx => {
      const rows = await tx.insert(refLog).values(updates.map(u => ({
        repoId,
        refName: u.refName,
        oldSha: u.oldSha,
        newSha: u.newSha,
        shardId: u.shardId,
        agentId: u.agentId ?? null,
      }))).returning();
      return rows;
    });
  }

  /** Replication tailer feed for a single repo. */
  async readSince(repoId: string, sinceSeq: number, limit = 256): Promise<RefLogEntry[]> {
    return this.db.select().from(refLog)
      .where(and(eq(refLog.repoId, repoId), gt(refLog.id, sinceSeq)))
      .orderBy(asc(refLog.id))
      .limit(limit);
  }

  /** Aggregate read for all repos hosted on a given shard. */
  async readSinceForShard(shardId: string, sinceSeq: number, limit = 1024): Promise<RefLogEntry[]> {
    return this.db.select().from(refLog)
      .where(and(eq(refLog.shardId, shardId), gt(refLog.id, sinceSeq)))
      .orderBy(asc(refLog.id))
      .limit(limit);
  }

  /** Highest seq for a repo — used by failover catch-up checks. */
  async latestSeq(repoId: string): Promise<number> {
    const r = await this.db.execute(sql`select coalesce(max(id), 0) as seq from ref_log where repo_id = ${repoId}`);
    const row = (r as unknown as Array<{ seq: number | string }>)[0];
    return Number(row?.seq ?? 0);
  }

  /**
   * Prune entries older than `keepLast` per repo. Run periodically by the
   * backup worker — backups already have a full ref snapshot so we only need
   * recent entries for live replication catch-up.
   */
  async prune(repoId: string, keepLast: number): Promise<number> {
    const r = await this.db.execute(sql`
      with cutoff as (
        select id from ref_log
        where repo_id = ${repoId}
        order by id desc
        offset ${keepLast} limit 1
      )
      delete from ref_log
      where repo_id = ${repoId}
        and id < (select id from cutoff)
      returning id
    `);
    return (r as unknown as Array<unknown>).length;
  }
}

/**
 * HMAC scheme for the internal endpoint. The hook script signs
 * `${ts}.${sha256(body)}` with the shared secret and sends both as headers.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface SignedRequest {
  timestamp: string;
  signature: string;
}

export function signInternalBody(body: string, secret: string, now = Date.now()): SignedRequest {
  const ts = String(Math.floor(now / 1000));
  const digest = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", secret).update(`${ts}.${digest}`).digest("hex");
  return { timestamp: ts, signature: sig };
}

export function verifyInternalSignature(body: string, secret: string, ts: string, sig: string, toleranceS = 300): boolean {
  if (!/^\d+$/.test(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > toleranceS) return false;
  const digest = createHash("sha256").update(body).digest("hex");
  const expected = createHmac("sha256", secret).update(`${ts}.${digest}`).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
