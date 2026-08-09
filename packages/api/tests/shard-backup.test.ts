import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { GitService } from "../src/services/git.js";
import { LocalObjectStore } from "../src/services/object-store.js";
import { ShardBackupService } from "../src/services/shard-backup.js";
import type { DB } from "../src/models/db.js";
import type { GitClientPool } from "../src/services/git-client.js";

const exec = promisify(execFile);

/**
 * #140 — S3 repo backups uploaded ZERO git objects while `restoreRepo` reported
 * success. A "backup" was a JSON list of `{refName, sha}`; restore `initBare`d
 * an empty repo, tried to point refs at SHAs that existed nowhere (git refuses:
 * "trying to write ref with nonexistent object"), swallowed every one of those
 * failures in a per-ref `catch`, and then unconditionally recorded
 * `clawhub_repo_restore_total{result="ok"}`. The operator was told disaster
 * recovery worked while holding a completely empty repository.
 *
 * These run against a REAL bare repo on the local git tier plus a real
 * `LocalObjectStore`, with a small in-memory stand-in for Postgres (the same
 * shape `pipeline-trigger.test.ts` uses) so the round trip is a always-on
 * regression guard rather than a DB-gated one. On today's master the round-trip
 * case fails at the very first assertion: the restored repo has no objects.
 */

// ---------------------------------------------------------------------------
// Minimal in-memory stand-in for the drizzle DB surface ShardBackupService uses.
// Rows are matched by scanning the bound parameters out of the drizzle
// condition and requiring every one of them to appear in the row — enough for
// the eq()/and() predicates this service issues, and it needs no Postgres.
// ---------------------------------------------------------------------------
function paramValues(cond: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const o = n as Record<string, unknown>;
    if (o.queryChunks) { walk(o.queryChunks); return; }
    if ("value" in o && (typeof o.value === "string" || typeof o.value === "number")) { out.push(o.value); return; }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(cond);
  return out;
}

type Row = Record<string, unknown>;

class FakeDb {
  tables = new Map<string, Row[]>();
  private seq = 0;

  rows(name: string): Row[] {
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  private nameOf(table: unknown): string {
    return is(table, PgTable) ? getTableName(table) : String(table);
  }

  /**
   * String params are equality matches (`eq(col, id)`); a numeric param is the
   * `gt(refLog.id, since)` threshold — the ONE inequality this service issues,
   * and the one #140 got wrong.
   */
  private match(rows: Row[], cond: unknown): Row[] {
    const params = paramValues(cond);
    if (!params.length) return rows;
    const eqs = params.filter(p => typeof p === "string");
    const gts = params.filter(p => typeof p === "number") as number[];
    return rows.filter(r =>
      eqs.every(p => Object.values(r).some(v => v === p))
      && gts.every(p => Number(r.id ?? 0) > p));
  }

  select(projection?: Row) {
    const self = this;
    return {
      from(table: unknown) {
        const name = self.nameOf(table);
        const run = (cond?: unknown): Row[] => {
          const rows = self.match(self.rows(name), cond);
          if (projection && "tip" in projection) {
            return [{ tip: rows.reduce((m, r) => Math.max(m, Number(r.id ?? 0)), 0) }];
          }
          if (projection && "n" in projection) return [{ n: rows.length }];
          if (projection && "id" in projection) return rows.map(r => ({ id: r.id }));
          return rows;
        };
        const chain = (cond?: unknown) => ({
          orderBy: () => chain(cond),
          limit: (n: number) => Promise.resolve(run(cond).slice(-n).reverse()),
          then: (res: (v: Row[]) => void, rej?: (e: unknown) => void) => Promise.resolve(run(cond)).then(res, rej),
        });
        return { where: (cond: unknown) => chain(cond), ...chain() };
      },
    };
  }

  insert(table: unknown) {
    const name = this.nameOf(table);
    const self = this;
    return {
      values(vals: Row) {
        const row: Row = { id: vals.id ?? `${name}-${++self.seq}`, createdAt: new Date(), ...vals };
        self.rows(name).push(row);
        return { returning: () => Promise.resolve([row]), then: (r: (v: unknown) => void) => Promise.resolve([row]).then(r) };
      },
    };
  }

  update(table: unknown) {
    const name = this.nameOf(table);
    const self = this;
    return {
      set(vals: Row) {
        return {
          where(cond: unknown) {
            for (const r of self.match(self.rows(name), cond)) Object.assign(r, vals);
            return Promise.resolve();
          },
        };
      },
    };
  }

  delete(table: unknown) {
    const name = this.nameOf(table);
    const self = this;
    return {
      where(cond: unknown) {
        const doomed = new Set(self.match(self.rows(name), cond));
        self.tables.set(name, self.rows(name).filter(r => !doomed.has(r)));
        return Promise.resolve();
      },
    };
  }
}

// The service only reaches for a shard client when the repo has a `repo_shards`
// placement; these tests exercise the LOCAL (default, single-node) tier, so any
// call through this pool is itself a failure.
const noShards = { rpc: () => { throw new Error("unexpected shard RPC in a local-tier test"); } } as unknown as GitClientPool;

const REPO_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";

describe("repo backups carry objects and restore fails loudly (#140)", () => {
  let root: string;
  let git: GitService;
  let store: LocalObjectStore;
  let db: FakeDb;
  let svc: ShardBackupService;

  async function seedRepo(): Promise<string> {
    await git.initBare("acme", "widgets");
    const work = path.join(root, "work");
    await mkdir(work, { recursive: true });
    const bare = git.pathOf("acme", "widgets");
    await exec("git", ["init", "-q", "-b", "main", work]);
    await exec("git", ["-C", work, "config", "user.email", "t@test.local"]);
    await exec("git", ["-C", work, "config", "user.name", "t"]);
    await writeFile(path.join(work, "README.md"), "# widgets\n");
    await exec("git", ["-C", work, "add", "-A"]);
    await exec("git", ["-C", work, "commit", "-qm", "initial"]);
    await exec("git", ["-C", work, "push", "-q", bare, "main"]);
    return (await exec("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  }

  async function commitMore(msg: string): Promise<string> {
    const work = path.join(root, "work");
    const bare = git.pathOf("acme", "widgets");
    await writeFile(path.join(work, `${msg}.txt`), `${msg}\n`);
    await exec("git", ["-C", work, "add", "-A"]);
    await exec("git", ["-C", work, "commit", "-qm", msg]);
    await exec("git", ["-C", work, "push", "-q", bare, "main"]);
    return (await exec("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "clawhub-backup-"));
    git = new GitService(path.join(root, "repos"));
    store = new LocalObjectStore(path.join(root, "backups"));
    db = new FakeDb();
    db.rows("users").push({ id: USER_ID, username: "acme" });
    db.rows("repositories").push({ id: REPO_ID, name: "widgets", namespaceType: "user", namespaceId: USER_ID });
    svc = new ShardBackupService(db as unknown as DB, noShards, store, git);
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("round-trips a repo through backup → total loss → restore", async () => {
    const sha = await seedRepo();
    const out = await svc.backupRepo(REPO_ID);

    // A backup that ships no objects cannot restore anything — this is the
    // property the whole feature was missing.
    expect(out.packCount).toBe(1);
    expect(out.packBytes).toBeGreaterThan(0);
    expect(out.full).toBe(true);
    expect(out.refCount).toBeGreaterThan(0);

    // Total loss of the repo directory.
    await git.remove("acme", "widgets");
    expect(await git.exists("acme", "widgets")).toBe(false);

    const res = await svc.restoreRepo(REPO_ID, String(db.rows("repo_backups")[0].id), "local");
    expect(res.failed).toBe(0);
    expect(res.restored).toBe(res.refs);
    expect(res.packsApplied).toBe(1);

    // The objects are really there, and the branch points at the ORIGINAL sha.
    expect(await git.hasObject("acme", "widgets", sha)).toBe(true);
    expect(await git.headCommit("acme", "widgets", "refs/heads/main")).toBe(sha);
    await exec("git", ["-C", git.pathOf("acme", "widgets"), "fsck", "--connectivity-only"]);
  });

  it("restores an incremental backup by walking the manifest chain", async () => {
    const sha1 = await seedRepo();
    const first = await svc.backupRepo(REPO_ID);
    expect(first.full).toBe(true);
    const sha2 = await commitMore("second");
    const second = await svc.backupRepo(REPO_ID);
    expect(second.full).toBe(false);
    expect(second.packCount).toBe(1);

    // Really incremental: the second pack alone carries the NEW commit and not
    // the one its parent backup already holds (size is a bad proxy on a repo
    // this small — pack framing dominates).
    const manifest2 = JSON.parse(await readAll(store, second.manifestKey)) as { packs: Array<{ key: string }> };
    await git.initBare("acme", "probe");
    await git.applyPack("acme", "probe", await readBuf(store, manifest2.packs[0].key));
    expect(await git.hasObject("acme", "probe", sha2)).toBe(true);
    expect(await git.hasObject("acme", "probe", sha1)).toBe(false);

    await git.remove("acme", "widgets");
    const backups = db.rows("repo_backups");
    const res = await svc.restoreRepo(REPO_ID, String(backups[backups.length - 1].id), "local");
    expect(res.packsApplied).toBe(2);
    expect(await git.headCommit("acme", "widgets", "refs/heads/main")).toBe(sha2);
    expect(await git.hasObject("acme", "widgets", sha2)).toBe(true);
  });

  it("REFUSES to report success when the objects are unavailable", async () => {
    await seedRepo();
    const out = await svc.backupRepo(REPO_ID);
    const backupId = String(db.rows("repo_backups")[0].id);

    // Simulate the pack being lost/pruned from the object store — the exact
    // state every pre-#140 backup was permanently in.
    const manifest = JSON.parse((await readAll(store, out.manifestKey))) as { packs: Array<{ key: string }> };
    await store.delete(manifest.packs[0].key);
    await git.remove("acme", "widgets");

    await expect(svc.restoreRepo(REPO_ID, backupId, "local")).rejects.toThrow(/pack missing/);
  });

  it("REFUSES a legacy refs-only manifest instead of producing an empty repo", async () => {
    await seedRepo();
    // Exactly what master wrote: a v1 manifest with `packs: []`.
    const refsKey = "clawhub/backups/legacy/refs.json";
    const manifestKey = "clawhub/backups/legacy/manifest.json";
    const refs = await git.listRefs("acme", "widgets", "refs/heads/");
    await store.put(refsKey, Buffer.from(JSON.stringify({ refs, count: refs.length })), "application/json");
    await store.put(manifestKey, Buffer.from(JSON.stringify({
      repoId: REPO_ID, refsKey, parentManifestKey: null, packs: [], refCount: refs.length,
    })), "application/json");
    db.rows("repo_backups").push({ id: "legacy-1", repoId: REPO_ID, shardId: "local", manifestKey, refsKey, packCount: 0, refLogTip: 0, createdAt: new Date() });

    await git.remove("acme", "widgets");
    await expect(svc.restoreRepo(REPO_ID, "legacy-1", "local")).rejects.toThrow(/not_restorable/);
  });

  it("binds the backup to its repo", async () => {
    await seedRepo();
    await svc.backupRepo(REPO_ID);
    const backupId = String(db.rows("repo_backups")[0].id);
    const other = "33333333-3333-3333-3333-333333333333";
    db.rows("repositories").push({ id: other, name: "gadgets", namespaceType: "user", namespaceId: USER_ID });
    await expect(svc.restoreRepo(other, backupId, "local")).rejects.toThrow(/does not belong/);
  });

  it("repoints placement at the tier it restored onto", async () => {
    await seedRepo();
    await svc.backupRepo(REPO_ID);
    // Pretend the repo was placed on a shard that has just been lost.
    db.rows("repo_shards").push({ repoId: REPO_ID, primaryShardId: "shard-a" });
    await git.remove("acme", "widgets");
    await svc.restoreRepo(REPO_ID, String(db.rows("repo_backups")[0].id), "local");
    // No `repo_shards` row IS the local placement (shard-map returns a synthetic
    // local shard) — otherwise the router keeps pointing at the dead shard.
    expect(db.rows("repo_shards")).toHaveLength(0);
  });

  it("listDueBackups compares the ref-log delta against the tip AT the last backup", async () => {
    await seedRepo();
    await svc.backupRepo(REPO_ID);
    const now = Date.now();
    const backup = db.rows("repo_backups")[0];
    backup.createdAt = new Date(now);

    // 50 lifetime ref-log rows, all of them from BEFORE the backup. With
    // maxRefDelta 10 this repo is NOT due — master compared against literal 0,
    // so any busy repo was due every hour forever.
    for (let i = 1; i <= 50; i++) db.rows("ref_log").push({ id: i, repoId: REPO_ID });
    backup.refLogTip = 50;
    expect(await svc.listDueBackups(now, { maxRefDelta: 10 })).toEqual([]);

    // 11 NEW entries past the tip does make it due again.
    for (let i = 51; i <= 61; i++) db.rows("ref_log").push({ id: i, repoId: REPO_ID });
    expect(await svc.listDueBackups(now, { maxRefDelta: 10 })).toEqual([REPO_ID]);
  });
});

describe("local git tier pack primitives (#140)", () => {
  let root: string;
  let git: GitService;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "clawhub-pack-"));
    git = new GitService(path.join(root, "repos"));
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("packs and re-applies objects between two bare repos", async () => {
    await git.initBare("acme", "src");
    const work = path.join(root, "w");
    await mkdir(work, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main", work]);
    await exec("git", ["-C", work, "config", "user.email", "t@test.local"]);
    await exec("git", ["-C", work, "config", "user.name", "t"]);
    await writeFile(path.join(work, "a.txt"), "a\n");
    await exec("git", ["-C", work, "add", "-A"]);
    await exec("git", ["-C", work, "commit", "-qm", "a"]);
    await exec("git", ["-C", work, "push", "-q", git.pathOf("acme", "src"), "main"]);
    const sha = (await exec("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();

    const pack = await git.packObjects("acme", "src", [sha]);
    expect(pack.length).toBeGreaterThan(0);
    expect(pack.subarray(0, 4).toString("utf8")).toBe("PACK");

    await git.initBare("acme", "dst");
    expect(await git.hasObject("acme", "dst", sha)).toBe(false);
    await git.applyPack("acme", "dst", pack);
    expect(await git.hasObject("acme", "dst", sha)).toBe(true);
    await git.updateRef("acme", "dst", "refs/heads/main", sha);
    expect(await git.headCommit("acme", "dst", "refs/heads/main")).toBe(sha);
  });

  it("returns an empty pack for no wants and ignores it on apply", async () => {
    await git.initBare("acme", "empty");
    const pack = await git.packObjects("acme", "empty", []);
    expect(pack.length).toBe(0);
    await expect(git.applyPack("acme", "empty", pack)).resolves.toBeUndefined();
  });

  it("surfaces a git failure instead of silently producing nothing", async () => {
    await git.initBare("acme", "bad");
    await expect(git.packObjects("acme", "bad", ["0".repeat(40)])).rejects.toThrow(/pack-objects/);
    await expect(git.applyPack("acme", "bad", Buffer.from("not a packfile at all"))).rejects.toThrow(/index-pack/);
  });
});

async function readBuf(store: LocalObjectStore, key: string): Promise<Buffer> {
  const obj = await store.get(key);
  if (!obj) throw new Error(`missing ${key}`);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    obj.stream.on("data", c => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    obj.stream.on("end", () => resolve(Buffer.concat(chunks)));
    obj.stream.on("error", reject);
  });
}

async function readAll(store: LocalObjectStore, key: string): Promise<string> {
  return (await readBuf(store, key)).toString("utf8");
}
