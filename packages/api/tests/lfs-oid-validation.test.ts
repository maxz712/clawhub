import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Security regression (#124): the LFS oid is a client-supplied URL param that
// was interpolated straight into a filesystem path. Hono URL-decodes `:oid`, so
// `..%2f..%2fetc%2fpasswd` arrived as a real relative path with `..` segments,
// giving any authenticated caller arbitrary file WRITE (a git hook = RCE) and
// arbitrary READ as the API process user.

// Auth is not what this suite is testing — stub it so every request reaches the
// handler as an authenticated caller, which is exactly the attacker's position.
vi.mock("../src/middleware/auth.js", () => ({
  authenticateGitRequestCached: async () => ({ actor: { kind: "agent", agentId: "a1", name: "att" } }),
  callerFromGitAuth: () => ({ kind: "agent", agentId: "a1", name: "attacker" }),
}));

// Spies, so we can assert the request never got as far as resolving a repo.
const resolveRepoForWrite = vi.fn(async () => ({ repo: { id: "repo-1" } }));
const resolveRepoForRead = vi.fn(async () => ({ repo: { id: "repo-1" } }));
vi.mock("../src/services/repo-access.js", () => ({
  resolveRepoForWrite: (...a: unknown[]) => resolveRepoForWrite(...(a as [])),
  resolveRepoForRead: (...a: unknown[]) => resolveRepoForRead(...(a as [])),
}));

const markUploaded = vi.fn(async () => {});
const getObjectRow = vi.fn(async () => ({ oid: "x", size: 1, uploaded: true }));
vi.mock("../src/services/lfs.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/services/lfs.js")>();
  return {
    ...actual,
    markUploaded: (...a: unknown[]) => markUploaded(...(a as [])),
    getObjectRow: (...a: unknown[]) => getObjectRow(...(a as [])),
  };
});

const { createLfsRoutes } = await import("../src/routes/lfs.js");
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { LfsStore, isValidOid, assertValidOid } = await import("../src/services/lfs.js");
type DB = import("../src/models/db.js").DB;

const VALID_OID = createHash("sha256").update("hello lfs").digest("hex");

// Every traversal shape from the report. The `%2e%2e%2f` variants are what
// reaches the handler post-decode; the encoded form is what goes on the wire.
const TRAVERSALS: Array<[label: string, encoded: string]> = [
  ["..%2f..%2f..%2fetc%2fpasswd", "..%2f..%2f..%2fetc%2fpasswd"],
  ["%2e%2e%2f%2e%2e%2fevil.js", "%2e%2e%2f%2e%2e%2fevil.js"],
  ["..%2fns%2fvictim.git%2fhooks%2fpost-receive", "..%2fns%2fvictim.git%2fhooks%2fpost-receive"],
  ["absolute", "%2fetc%2fcron.d%2fpwn"],
  ["short hex", "abc123"],
  ["uppercase hex", VALID_OID.toUpperCase()],
  ["nul byte", `${VALID_OID.slice(0, 63)}%00`],
];

let baseDir = "";
let store: InstanceType<typeof LfsStore>;

function buildApp(): Hono {
  const root = new Hono();
  root.route("/", createLfsRoutes({} as DB, store, "http://localhost:3000"));
  root.onError(errorHandler);
  return root;
}

/** Everything under baseDir, relative — so we can assert "nothing was written". */
async function treeOf(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await treeOf(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

beforeEach(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "clawhub-lfs-"));
  store = new LfsStore(baseDir);
  resolveRepoForWrite.mockClear();
  resolveRepoForRead.mockClear();
  markUploaded.mockClear();
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("oid predicate", () => {
  it("accepts exactly a 64-char lowercase hex sha256", () => {
    expect(isValidOid(VALID_OID)).toBe(true);
    expect(assertValidOid(VALID_OID)).toBe(VALID_OID);
  });

  it("rejects traversal, absolute, wrong-length, uppercase, NUL and non-strings", () => {
    for (const bad of [
      "../x", "..", "/etc/passwd", "../../../etc/passwd", "a".repeat(63), "a".repeat(65),
      VALID_OID.toUpperCase(), `${VALID_OID.slice(0, 63)}\0`, "", "abc123", `${VALID_OID}/..`,
    ]) {
      expect(isValidOid(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
      expect(() => assertValidOid(bad)).toThrow(/invalid_oid/);
    }
    expect(isValidOid(undefined)).toBe(false);
    expect(isValidOid(null)).toBe(false);
    expect(isValidOid(123)).toBe(false);
  });
});

describe("LfsStore path containment (defence in depth)", () => {
  // pathFor is private; the point of these cases is that a caller who SKIPS the
  // route validation still cannot escape, so we reach past the type.
  const pathFor = (repoId: string, oid: string) =>
    (store as unknown as { pathFor(r: string, o: string): string }).pathFor(repoId, oid);

  it("throws for traversal / absolute oids instead of resolving outside the store", () => {
    for (const bad of ["../x", "..", "/etc/passwd", "../../../../etc/cron.d/pwn"]) {
      expect(() => pathFor("repo-1", bad), `should reject ${bad}`).toThrow(/illegal_lfs_path/);
    }
  });

  it("throws for a traversal repoId too", () => {
    expect(() => pathFor("../..", VALID_OID)).toThrow(/illegal_lfs_path/);
  });

  it("keeps a valid oid inside <baseDir>/lfs/<repoId>/<ab>/<oid>", () => {
    const p = pathFor("repo-1", VALID_OID);
    expect(p).toBe(path.join(path.resolve(baseDir), "lfs", "repo-1", VALID_OID.slice(0, 2), VALID_OID));
  });

  it("surfaces the violation from exists()/openObject() rather than swallowing it", async () => {
    await expect(store.exists("repo-1", "../x")).rejects.toThrow(/illegal_lfs_path/);
    await expect(store.openObject("repo-1", "../x")).rejects.toThrow(/illegal_lfs_path/);
  });
});

describe("LfsStore.writeObject integrity", () => {
  it("round-trips a valid object: write -> exists -> read", async () => {
    const buf = Buffer.from("hello lfs");
    const { size, shaHex } = await store.writeObject("repo-1", VALID_OID, buf);
    expect(shaHex).toBe(VALID_OID);
    expect(size).toBe(buf.length);
    expect(await store.exists("repo-1", VALID_OID)).toBe(true);
    const opened = await store.openObject("repo-1", VALID_OID);
    expect(opened?.size).toBe(buf.length);
  });

  it("publishes NOTHING when the bytes don't hash to the declared oid", async () => {
    const { shaHex } = await store.writeObject("repo-1", VALID_OID, Buffer.from("not the declared content"));
    expect(shaHex).not.toBe(VALID_OID);
    // Neither the destination nor a leftover .tmp- file may survive.
    expect(await store.exists("repo-1", VALID_OID)).toBe(false);
    expect(await treeOf(baseDir)).toEqual([]);
  });

  it("does not overwrite an already-good object with mismatched bytes", async () => {
    await store.writeObject("repo-1", VALID_OID, Buffer.from("hello lfs"));
    await store.writeObject("repo-1", VALID_OID, Buffer.from("poison"));
    const dest = path.join(baseDir, "lfs", "repo-1", VALID_OID.slice(0, 2), VALID_OID);
    expect(await readFile(dest, "utf8")).toBe("hello lfs");
  });
});

describe("LFS routes reject traversal oids", () => {
  for (const [label, encoded] of TRAVERSALS) {
    it(`PUT /lfs/objects/${label} -> 400 and writes nothing`, async () => {
      const res = await buildApp().request(`/ns/repo.git/lfs/objects/${encoded}`, {
        method: "PUT", body: "#!/bin/sh\nPWNED\n",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation", message: "invalid_oid" });
      // Never reached authorization, the DB, or the filesystem.
      expect(resolveRepoForWrite).not.toHaveBeenCalled();
      expect(markUploaded).not.toHaveBeenCalled();
      expect(await treeOf(baseDir)).toEqual([]);
    });

    it(`GET /lfs/objects/${label} -> 400`, async () => {
      const res = await buildApp().request(`/ns/repo.git/lfs/objects/${encoded}`);
      expect(res.status).toBe(400);
      expect(resolveRepoForRead).not.toHaveBeenCalled();
    });

    it(`POST /lfs/objects/verify/${label} -> 400`, async () => {
      const res = await buildApp().request(`/ns/repo.git/lfs/objects/verify/${encoded}`, { method: "POST" });
      expect(res.status).toBe(400);
      expect(resolveRepoForWrite).not.toHaveBeenCalled();
    });

    it(`batch with objects[].oid = ${label} -> 400`, async () => {
      const res = await buildApp().request("/ns/repo.git/info/lfs/objects/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "upload", objects: [{ oid: decodeURIComponent(encoded), size: 3 }] }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "validation", message: "invalid_oid" });
    });
  }

  it("a poisoned hook path does not land on disk (the RCE primitive)", async () => {
    // Stage a victim repo's hook inside the same base dir the store sits in,
    // exactly as production does (LfsStore is constructed on git.basePath).
    const hook = path.join(baseDir, "ns", "victim.git", "hooks", "post-receive");
    await mkdir(path.dirname(hook), { recursive: true });
    await writeFile(hook, "#!/bin/sh\noriginal\n");

    const res = await buildApp().request(
      "/ns/repo.git/lfs/objects/..%2fns%2fvictim.git%2fhooks%2fpost-receive",
      { method: "PUT", body: "#!/bin/sh\nPWNED\n" },
    );
    expect(res.status).toBe(400);
    expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\noriginal\n");
  });

  it("still serves the happy path for a valid oid", async () => {
    const app = buildApp();
    const put = await app.request(`/ns/repo.git/lfs/objects/${VALID_OID}`, { method: "PUT", body: "hello lfs" });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ oid: VALID_OID, size: 9 });
    expect(resolveRepoForWrite).toHaveBeenCalled();
    expect(existsSync(path.join(baseDir, "lfs", "repo-1", VALID_OID.slice(0, 2), VALID_OID))).toBe(true);

    const get = await app.request(`/ns/repo.git/lfs/objects/${VALID_OID}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello lfs");

    const batch = await app.request("/ns/repo.git/info/lfs/objects/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "download", objects: [{ oid: VALID_OID, size: 9 }] }),
    });
    expect(batch.status).toBe(200);
  });

  it("returns oid_mismatch and leaves nothing on disk when bytes don't match", async () => {
    const res = await buildApp().request(`/ns/repo.git/lfs/objects/${VALID_OID}`, {
      method: "PUT", body: "wrong bytes",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "validation", message: "oid_mismatch" });
    expect(markUploaded).not.toHaveBeenCalled();
    expect(await treeOf(baseDir)).toEqual([]);
  });
});
