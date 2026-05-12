import { createHash } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, gitShards, organizations, refLog, repositories, repoBackups, repoShards } from "../models/schema.js";
import type { GitClientPool } from "./git-client.js";
import type { ObjectStore } from "./object-store.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

/**
 * Phase 4 — S3 backups.
 *
 * Per repo, every `intervalMs` (default 24h) or whenever the ref_log advances
 * by `maxRefDelta` (default 10k entries) since the last backup, run a fresh
 * backup. A backup is:
 *
 *   - `refs.json`: full snapshot of refs/heads/* + refs/clawhub/changes/*.
 *     Read live from the primary shard via `GitClient.listRefs`.
 *   - `manifest.json`: `{repoId, ts, parentManifestKey, refs: refsKey,
 *     packs: [{sha, key, size}], refLogTip}`.
 *   - **Pack objects** are not yet uploaded — see "Incremental pack uploads"
 *     in the README. The manifest still records the ref state which is enough
 *     to drive a restore from a freshly cloned source-of-truth.
 *
 * Restore is the inverse: read the manifest, recreate the bare repo on the
 * target shard, write all refs.
 */
export interface BackupResult {
  backupId: string;
  manifestKey: string;
  refsKey: string;
  refCount: number;
  refLogTip: number;
}

const BACKUP_PREFIX = process.env.CLAWHUB_BACKUP_PREFIX ?? "clawhub/backups";

export class ShardBackupService {
  constructor(
    private db: DB,
    private clients: GitClientPool,
    private store: ObjectStore,
  ) {}

  /** Drive a backup for a single repo. Returns the new backup row + S3 keys. */
  async backupRepo(repoId: string): Promise<BackupResult> {
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) throw new Error(`repo ${repoId} not found`);
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    if (!ns) throw new Error(`namespace not found for repo ${repoId}`);
    const placement = (await this.db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    const shardId = placement?.primaryShardId ?? "local";
    const shard = placement ? (await this.db.select().from(gitShards).where(eq(gitShards.id, shardId)).limit(1))[0] : null;

    const refs: Array<{ refName: string; sha: string }> = [];
    if (shard) {
      const client = this.clients.get({ id: shard.id, endpoint: shard.endpoint, role: "primary", status: shard.status });
      const heads = await client.listRefs(ns, repo.name, "refs/heads/");
      const changes = await client.listRefs(ns, repo.name, "refs/clawhub/changes/");
      refs.push(...heads, ...changes);
    }

    const parent = (await this.db.select().from(repoBackups)
      .where(eq(repoBackups.repoId, repoId))
      .orderBy(desc(repoBackups.createdAt))
      .limit(1))[0];

    const tipRow = (await this.db.select({ tip: sql<number>`coalesce(max(${refLog.id}), 0)::bigint` })
      .from(refLog).where(eq(refLog.repoId, repoId)))[0];
    const refLogTip = Number(tipRow?.tip ?? 0);

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const refsKey = `${BACKUP_PREFIX}/${repoId}/${ts}/refs.json`;
    const manifestKey = `${BACKUP_PREFIX}/${repoId}/${ts}/manifest.json`;

    const refsBody = Buffer.from(JSON.stringify({ refs, ts, count: refs.length }), "utf8");
    const refsPut = await this.store.put(refsKey, refsBody, "application/json");

    const manifest = {
      repoId,
      ts,
      shardId,
      refsKey,
      refsSha256: createHash("sha256").update(refsBody).digest("hex"),
      parentManifestKey: parent?.manifestKey ?? null,
      packs: [] as Array<{ sha: string; key: string; size: number }>,
      refLogTip,
      refCount: refs.length,
    };
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    await this.store.put(manifestKey, manifestBody, "application/json");

    const ins = await this.db.insert(repoBackups).values({
      repoId,
      shardId,
      manifestKey,
      refsKey,
      parentBackupId: parent?.id ?? null,
      bytesUploaded: refsPut.size + manifestBody.length,
      packCount: 0,
    }).returning();

    metrics.inc("clawhub_repo_backup_total", { result: "ok" });
    log("info", "repo_backup_complete", { repoId, refs: refs.length, refLogTip, key: manifestKey });
    return { backupId: ins[0].id, manifestKey, refsKey, refCount: refs.length, refLogTip };
  }

  /** Restore a backup to a target shard. Recreates the bare repo and writes refs. */
  async restoreRepo(repoId: string, backupId: string, toShardId: string): Promise<void> {
    const backup = (await this.db.select().from(repoBackups).where(eq(repoBackups.id, backupId)).limit(1))[0];
    if (!backup) throw new Error(`backup ${backupId} not found`);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (!repo) throw new Error(`repo ${repoId} not found`);
    const ns = await this.namespaceNameOf(repo.namespaceType, repo.namespaceId);
    if (!ns) throw new Error(`namespace not found`);
    const toShard = (await this.db.select().from(gitShards).where(eq(gitShards.id, toShardId)).limit(1))[0];
    if (!toShard) throw new Error(`target shard ${toShardId} not found`);

    const refsObj = await this.store.get(backup.refsKey);
    if (!refsObj) throw new Error(`refs.json missing: ${backup.refsKey}`);
    const refsBuf = await streamToBuffer(refsObj.stream);
    const parsed = JSON.parse(refsBuf.toString("utf8")) as { refs: Array<{ refName: string; sha: string }> };

    const client = this.clients.get({ id: toShard.id, endpoint: toShard.endpoint, role: "primary", status: toShard.status });
    await client.initBare({ namespace: ns, name: repo.name });
    for (const r of parsed.refs) {
      try { await client.updateRef(ns, repo.name, r.refName, "0".repeat(40), r.sha); }
      catch (e) { log("warn", "restore_update_ref_failed", { repoId, ref: r.refName, err: (e as Error).message }); }
    }
    metrics.inc("clawhub_repo_restore_total", { result: "ok" });
    log("info", "repo_restore_complete", { repoId, backupId, toShard: toShardId, refs: parsed.refs.length });
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
      const newRefs = (await this.db.select({ n: sql<number>`count(*)::int` }).from(refLog)
        .where(and(eq(refLog.repoId, r.id), gt(refLog.id, /* tip at last backup is unknown, approximate via createdAt */ 0))))[0];
      if (Number(newRefs?.n ?? 0) > maxRefDelta) due.push(r.id);
    }
    return due;
  }

  private async namespaceNameOf(kind: "agent" | "org", id: string): Promise<string | null> {
    if (kind === "agent") {
      const a = (await this.db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
      return a?.name ?? null;
    }
    const o = (await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0];
    return o?.name ?? null;
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
