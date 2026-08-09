import { createHash } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "./git.js";
import { gitShards, refLog, repositories, repoBackups, repoShards } from "../models/schema.js";
import type { GitClientPool } from "./git-client.js";
import { namespaceNameOf, type NamespaceKind } from "./namespace.js";
import type { ObjectStore } from "./object-store.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

/**
 * Phase 4 — S3 backups.
 *
 * Per repo, every `intervalMs` (default 24h) or whenever the ref_log advances
 * by `maxRefDelta` (default 10k entries) SINCE THE LAST BACKUP'S TIP, run a
 * fresh backup. A backup is:
 *
 *   - `objects.pack`: a real packfile carrying every object reachable from the
 *     snapshotted refs. Incremental backups pass the PARENT backup's ref shas
 *     as `haves`, so only new objects are uploaded; a full pack is taken when
 *     there is no usable parent or the chain reaches `CLAWHUB_BACKUP_FULL_EVERY`.
 *   - `refs.json`: full snapshot of refs/heads/* + refs/clawhub/changes/*.
 *   - `manifest.json`: `{version, repoId, ts, parentManifestKey, refsKey,
 *     packs: [{key, size, sha256, wants, haves}], refShas, refLogTip, full}`.
 *
 * Restore is the inverse: walk the manifest chain back to the last FULL pack,
 * apply every pack oldest-first, then write the refs.
 *
 * #140: this used to upload nothing but `refs.json` while `restoreRepo`
 * `initBare`d an empty repo and pointed refs at SHAs that existed nowhere.
 * Every `update-ref` threw ("nonexistent object"), the per-ref `catch`
 * discarded it, and the function unconditionally recorded `result:"ok"` — so
 * the operator was told disaster recovery worked while holding an empty repo.
 * Two invariants now hold: a backup carries its objects, and a restore that
 * loses a single ref FAILS LOUDLY (throws, `result:"failed"`, non-2xx).
 */
export interface BackupResult {
  backupId: string;
  manifestKey: string;
  refsKey: string;
  refCount: number;
  refLogTip: number;
  packCount: number;
  packBytes: number;
  bytesUploaded: number;
  full: boolean;
}

export interface RestoreResult {
  refs: number;
  restored: number;
  failed: number;
  packsApplied: number;
  toShardId: string;
}

interface PackEntry { key: string; size: number; sha256: string; wants: string[]; haves: string[] }

interface BackupManifest {
  /** 1 = the legacy refs-only manifest (#140), which is NOT restorable. */
  version: number;
  repoId: string;
  ts: string;
  shardId: string;
  refsKey: string;
  refsSha256: string;
  parentManifestKey: string | null;
  packs: PackEntry[];
  /** Ref shas of THIS backup — the `haves` baseline the next incremental uses. */
  refShas: string[];
  refLogTip: number;
  refCount: number;
  /** Number of incremental backups since the last full pack (0 = full). */
  chainDepth: number;
  full: boolean;
}

const BACKUP_PREFIX = process.env.CLAWHUB_BACKUP_PREFIX ?? "clawhub/backups";
/** Take a fresh FULL pack at least this often so a restore never walks an unbounded chain. */
const FULL_EVERY = Math.max(1, Number(process.env.CLAWHUB_BACKUP_FULL_EVERY ?? 10));
/** Placement id meaning "the local disk tier" — a repo with no `repo_shards` row. */
export const LOCAL_SHARD_ID = "local";

export class ShardBackupService {
  constructor(
    private db: DB,
    private clients: GitClientPool,
    private store: ObjectStore,
    // #64: unsharded repos live on the LOCAL disk tier — without this the hourly
    // sweep wrote empty refs.json manifests for every local repo (i.e. every
    // repo on a fresh instance) while reporting success. #140 gives the local
    // tier the pack half too, so the DEFAULT (single-node) deployment shape is
    // both backed up and restorable.
    private git?: GitService,
  ) {}

  /** Drive a backup for a single repo. Returns the new backup row + S3 keys. */
  async backupRepo(repoId: string): Promise<BackupResult> {
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) throw new Error(`repo ${repoId} not found`);
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    if (!ns) throw new Error(`namespace not found for repo ${repoId}`);
    const placement = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    const shardId = placement?.primaryShardId ?? LOCAL_SHARD_ID;
    const shard = placement ? (await this.db.select().from(gitShards).where(eq(gitShards.id, shardId)).limit(1))[0] : null;
    if (!shard && !this.git) {
      metrics.inc("clawhub_repo_backup_total", { result: "failed" });
      throw new Error(`no git tier available to back up repo ${repoId}`);
    }

    const client = shard
      ? this.clients.rpc({ id: shard.id, endpoint: shard.endpoint, role: "primary", status: shard.status })
      : null;

    const refs: Array<{ refName: string; sha: string }> = [];
    if (client) {
      const heads = await client.listRefs(ns, repo.name, "refs/heads/");
      const changes = await client.listRefs(ns, repo.name, "refs/clawhub/changes/");
      refs.push(...heads, ...changes);
    } else {
      const heads = await this.git!.listRefs(ns, repo.name, "refs/heads/").catch(() => []);
      const changes = await this.git!.listRefs(ns, repo.name, "refs/clawhub/changes/").catch(() => []);
      refs.push(...heads, ...changes);
    }

    const parent = (await this.db.select().from(repoBackups)
      .where(eq(repoBackups.repoId, repoId))
      .orderBy(desc(repoBackups.createdAt))
      .limit(1))[0];
    // Only a v2 (object-carrying) parent can serve as an incremental baseline —
    // a legacy refs-only row has no packs for the restore chain to walk back to.
    const parentManifest = parent ? await this.readManifest(parent.manifestKey).catch(() => null) : null;
    const usableParent = parentManifest && parentManifest.version >= 2 && parentManifest.chainDepth + 1 < FULL_EVERY
      ? parentManifest : null;
    // A sharded fetch-pack takes `wants` only (no `haves` in the RPC), so a
    // sharded backup is always full. Local backups go incremental.
    const haves = !client && usableParent ? usableParent.refShas : [];
    const full = haves.length === 0;

    const tipRow = (await this.db.select({ tip: sql<number>`coalesce(max(${refLog.id}), 0)::bigint` })
      .from(refLog).where(eq(refLog.repoId, repoId)))[0];
    const refLogTip = Number(tipRow?.tip ?? 0);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const refsKey = `${BACKUP_PREFIX}/${repoId}/${ts}/refs.json`;
    const packKey = `${BACKUP_PREFIX}/${repoId}/${ts}/objects.pack`;
    const manifestKey = `${BACKUP_PREFIX}/${repoId}/${ts}/manifest.json`;

    const wants = [...new Set(refs.map(r => r.sha))];
    const packs: PackEntry[] = [];
    if (wants.length) {
      const pack = client
        ? Buffer.from(await client.fetchPack(ns, repo.name, wants))
        : await this.git!.packObjects(ns, repo.name, wants, haves);
      // An incremental with nothing new legitimately produces an empty delta;
      // a FULL pack for a repo that has refs must never be empty.
      if (!pack.length && full) {
        metrics.inc("clawhub_repo_backup_total", { result: "failed" });
        throw new Error(`backup produced no objects for repo ${repoId} (${wants.length} refs)`);
      }
      if (pack.length) {
        const put = await this.store.put(packKey, pack, "application/octet-stream");
        packs.push({
          key: packKey, size: put.size,
          sha256: createHash("sha256").update(pack).digest("hex"),
          wants, haves,
        });
      }
    }

    const refsBody = Buffer.from(JSON.stringify({ refs, ts, count: refs.length }), "utf8");
    const refsPut = await this.store.put(refsKey, refsBody, "application/json");

    const manifest: BackupManifest = {
      version: 2,
      repoId,
      ts,
      shardId,
      refsKey,
      refsSha256: createHash("sha256").update(refsBody).digest("hex"),
      parentManifestKey: full ? null : parent!.manifestKey,
      packs,
      refShas: wants,
      refLogTip,
      refCount: refs.length,
      chainDepth: full ? 0 : usableParent!.chainDepth + 1,
      full,
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    await this.store.put(manifestKey, manifestBody, "application/json");

    const packBytes = packs.reduce((n, p) => n + p.size, 0);
    const ins = await this.db.insert(repoBackups).values({
      repoId,
      shardId,
      manifestKey,
      refsKey,
      parentBackupId: full ? null : parent!.id,
      bytesUploaded: packBytes + refsPut.size + manifestBody.length,
      packCount: packs.length,
      refLogTip,
    }).returning();

    metrics.inc("clawhub_repo_backup_total", { result: "ok" });
    metrics.inc("clawhub_repo_backup_bytes_total", {}, packBytes);
    metrics.inc("clawhub_repo_backup_packs_total", {}, packs.length);
    // Dead-man signal: a backup that snapshotted refs but shipped no objects and
    // has no parent to inherit them from is not restorable. `ClawHubBackupStale`
    // cannot see this — the ok counter advances all the same.
    if (refs.length > 0 && packs.length === 0 && full) metrics.inc("clawhub_repo_backup_empty_total", {});
    log("info", "repo_backup_complete", { repoId, refs: refs.length, refLogTip, packs: packs.length, packBytes, full, key: manifestKey });
    return {
      backupId: ins[0].id, manifestKey, refsKey, refCount: refs.length, refLogTip,
      packCount: packs.length, packBytes, bytesUploaded: packBytes + refsPut.size + manifestBody.length, full,
    };
  }

  /**
   * Restore a backup to a target shard (`"local"` for the unsharded disk tier).
   * Recreates the bare repo, applies the manifest chain's packs oldest-first,
   * writes every ref, and repoints the placement. Throws — loudly — if any pack
   * is missing or any ref fails to write; there is no partial "ok".
   */
  async restoreRepo(repoId: string, backupId: string, toShardId: string): Promise<RestoreResult> {
    try {
      const out = await this.restoreRepoInner(repoId, backupId, toShardId);
      metrics.inc("clawhub_repo_restore_total", { result: "ok" });
      log("info", "repo_restore_complete", { repoId, backupId, toShard: toShardId, ...out });
      return out;
    } catch (e) {
      metrics.inc("clawhub_repo_restore_total", { result: "failed" });
      log("error", "repo_restore_failed", { repoId, backupId, toShard: toShardId, err: (e as Error).message });
      throw e;
    }
  }

  private async restoreRepoInner(repoId: string, backupId: string, toShardId: string): Promise<RestoreResult> {
    const backup = (await this.db.select().from(repoBackups).where(eq(repoBackups.id, backupId)).limit(1))[0];
    if (!backup) throw new Error(`backup ${backupId} not found`);
    if (backup.repoId !== repoId) throw new Error(`backup ${backupId} does not belong to repo ${repoId}`);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) throw new Error(`repo ${repoId} not found`);
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    if (!ns) throw new Error(`namespace not found`);

    const local = toShardId === LOCAL_SHARD_ID;
    if (local && !this.git) throw new Error(`no local git tier configured; cannot restore to "${LOCAL_SHARD_ID}"`);
    const toShard = local
      ? null
      : (await this.db.select().from(gitShards).where(eq(gitShards.id, toShardId)).limit(1))[0];
    if (!local && !toShard) throw new Error(`target shard ${toShardId} not found`);

    // Walk the parent chain back to the last FULL pack BEFORE touching the
    // target, so an unrestorable backup fails before it creates an empty repo.
    const chain = await this.resolveChain(backup.manifestKey);
    const head = chain[chain.length - 1];

    const refsObj = await this.store.get(head.refsKey);
    if (!refsObj) throw new Error(`refs.json missing: ${head.refsKey}`);
    const refsBuf = await streamToBuffer(refsObj.stream);
    const parsed = JSON.parse(refsBuf.toString("utf8")) as { refs: Array<{ refName: string; sha: string }> };

    const client = toShard
      ? this.clients.rpc({ id: toShard.id, endpoint: toShard.endpoint, role: "primary", status: toShard.status })
      : null;
    if (client) await client.initBare({ namespace: ns, name: repo.name });
    else await this.git!.initBare(ns, repo.name);

    let packsApplied = 0;
    for (const m of chain) {
      for (const p of m.packs) {
        const obj = await this.store.get(p.key);
        if (!obj) throw new Error(`pack missing from backup store: ${p.key}`);
        const pack = await streamToBuffer(obj.stream);
        const sha256 = createHash("sha256").update(pack).digest("hex");
        if (p.sha256 && sha256 !== p.sha256) throw new Error(`pack checksum mismatch: ${p.key}`);
        if (client) await client.applyPack(ns, repo.name, pack);
        else await this.git!.applyPack(ns, repo.name, pack);
        packsApplied++;
      }
    }

    let restored = 0;
    const failures: Array<{ ref: string; err: string }> = [];
    for (const r of parsed.refs) {
      try {
        if (client) await client.updateRef(ns, repo.name, r.refName, "0".repeat(40), r.sha);
        else await this.git!.updateRef(ns, repo.name, r.refName, r.sha);
        restored++;
      } catch (e) {
        failures.push({ ref: r.refName, err: (e as Error).message });
        log("warn", "restore_update_ref_failed", { repoId, ref: r.refName, err: (e as Error).message });
      }
    }
    if (failures.length) {
      throw new Error(
        `restore incomplete: ${failures.length}/${parsed.refs.length} refs failed to write ` +
        `(first: ${failures[0].ref} — ${failures[0].err})`,
      );
    }

    // The router still pointed at the OLD placement, so objects landed on a
    // shard nobody reads from. Repoint it as the last step of a clean restore.
    await this.repoint(repoId, toShardId, local);

    return { refs: parsed.refs.length, restored, failed: 0, packsApplied, toShardId };
  }

  /** Oldest-first manifest chain: the last FULL pack through `manifestKey`. */
  private async resolveChain(manifestKey: string): Promise<BackupManifest[]> {
    const chain: BackupManifest[] = [];
    let key: string | null = manifestKey;
    const seen = new Set<string>();
    while (key) {
      if (seen.has(key)) throw new Error(`backup manifest chain loops at ${key}`);
      seen.add(key);
      const m: BackupManifest = await this.readManifest(key);
      if ((m.version ?? 1) < 2) {
        throw new Error(
          `not_restorable: backup ${key} predates object upload (refs-only) — ` +
          `restore it from a source-of-truth clone or take a fresh backup`,
        );
      }
      chain.unshift(m);
      if (m.full) break;
      if (!m.parentManifestKey) throw new Error(`not_restorable: incremental backup ${key} has no parent manifest`);
      key = m.parentManifestKey;
    }
    if (!chain.length) throw new Error(`not_restorable: empty manifest chain for ${manifestKey}`);
    return chain;
  }

  private async readManifest(key: string): Promise<BackupManifest> {
    const obj = await this.store.get(key);
    if (!obj) throw new Error(`manifest missing from backup store: ${key}`);
    const buf = await streamToBuffer(obj.stream);
    const m = JSON.parse(buf.toString("utf8")) as BackupManifest;
    m.packs ??= [];
    m.refShas ??= [];
    m.chainDepth ??= 0;
    return m;
  }

  /** Point the repo's placement at the shard we just restored onto. */
  private async repoint(repoId: string, toShardId: string, local: boolean): Promise<void> {
    if (local) {
      // No `repo_shards` row IS the local placement (`shard-map.ts` returns a
      // synthetic local shard when nothing is placed).
      await this.db.delete(repoShards).where(eq(repoShards.repoId, repoId));
      return;
    }
    const existing = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (existing) await this.db.update(repoShards).set({ primaryShardId: toShardId }).where(eq(repoShards.repoId, repoId));
    else await this.db.insert(repoShards).values({ repoId, primaryShardId: toShardId });
  }

  /** List repos eligible for a backup (none within `intervalMs` or ref-log advanced). */
  async listDueBackups(now = Date.now(), opts: { intervalMs?: number; maxRefDelta?: number } = {}): Promise<string[]> {
    const intervalMs = opts.intervalMs ?? 24 * 3600 * 1000;
    const maxRefDelta = opts.maxRefDelta ?? 10_000;
    const allRepos = await this.db.select({ id: repositories.id }).from(repositories);
    const due: string[] = [];
    for (const r of allRepos) {
      const last = (await this.db.select().from(repoBackups)
        .where(eq(repoBackups.repoId, r.id)).orderBy(desc(repoBackups.createdAt)).limit(1))[0];
      if (!last) { due.push(r.id); continue; }
      if (now - new Date(last.createdAt).getTime() > intervalMs) { due.push(r.id); continue; }
      // #140: this compared against literal 0 — i.e. every ref_log row the repo
      // ever produced — because the tip was computed, written into the manifest
      // and dropped on the floor. Past 10k lifetime entries the condition was
      // permanently true and the hourly sweep re-backed-up the repo forever.
      const since = Number(last.refLogTip ?? 0);
      const newRefs = (await this.db.select({ n: sql<number>`count(*)::int` }).from(refLog)
        .where(and(eq(refLog.repoId, r.id), gt(refLog.id, since))))[0];
      if (Number(newRefs?.n ?? 0) > maxRefDelta) due.push(r.id);
    }
    return due;
  }

  private async namespaceNameOf(kind: NamespaceKind, id: string): Promise<string | null> {
    return namespaceNameOf(this.db, kind, id);
  }
}

async function streamToBuffer(s: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    s.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    s.on("end", () => resolve(Buffer.concat(chunks)));
    s.on("error", reject);
  });
}
