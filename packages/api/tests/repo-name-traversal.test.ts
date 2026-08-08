import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import path from "node:path";
import { mkdtemp, rm, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { testDb as db, hasTestDb } from "./test-db.js";
import { and, eq } from "drizzle-orm";
import { repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { assertSafeRepoName, isSafePathSegment, sanitizeRepoName } from "../src/services/namespace.js";
import { createForkRoutes } from "../src/routes/forks.js";
import { createCodeRoutes } from "../src/routes/code.js";
import { createMigrationRoutes } from "../src/routes/migration.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import type { EventBus } from "../src/services/events.js";

process.env.JWT_SECRET ??= "test-secret-repo-name-traversal";

// Issue #138: `repositories.name` is BOTH a DB identifier and an on-disk path
// segment (`<base>/<ns>/<repo>.git` via `git.pathOf`). `isSafePathSegment`
// existed but was wired into exactly one of the four creation sites (git-push),
// so import (`targetRepoName`) and fork (`name`) took the value straight off the
// request body. `../victim/private-repo` then produced a row the ATTACKER owns
// — every authorization check passes legitimately — while `pathOf` resolved into
// another tenant's directory: a cross-tenant read primitive through blob/tree,
// and (fork clones before it inserts) an arbitrary-path write primitive.
//
// Two layers, tested separately, because the class of bug recurs at every new
// creation site:
//   1. boundary  — `assertSafeRepoName` at each site that writes a caller name.
//   2. sink      — `git.pathOf` asserts containment, so a row that got in some
//                  OTHER way (a legacy row, the next unguarded creation site)
//                  still cannot read or write outside the repo root.
const S = Date.now();

describe("repo-name path-segment validators (#138)", () => {
  it("rejects every traversal spelling a caller could put in targetRepoName / fork name", () => {
    for (const bad of [
      "../victim/private-repo", "..", ".", "./x", "a/../b", "..%2Fx",
      "/etc/passwd", "../../../../tmp/pwn", "a\\b", "a/b", "a\0b",
      "-oProxyCommand=x", ".hidden", "", "x".repeat(101),
    ]) {
      expect(isSafePathSegment(bad), `expected unsafe: ${JSON.stringify(bad)}`).toBe(false);
      expect(() => assertSafeRepoName(bad, "targetRepoName")).toThrowError(/invalid targetRepoName/);
    }
    for (const bad of [undefined, null, 42, {}]) {
      expect(() => assertSafeRepoName(bad, "name")).toThrowError(/invalid name/);
    }
  });

  it("still accepts the ordinary names real imports and forks use", () => {
    for (const ok of ["clawhub", "my-repo", "my_repo", "repo.js", "a", "A1", "x".repeat(100), "repo-2.0_beta"]) {
      expect(isSafePathSegment(ok), `expected safe: ${ok}`).toBe(true);
      expect(assertSafeRepoName(ok)).toBe(ok);
    }
  });

  it("sanitizes an UPSTREAM-derived name instead of failing the import", () => {
    // GitLab's `project.name` is a display name the caller never typed — the
    // github-mirror.ts:shadowRepoName precedent, generalized.
    expect(sanitizeRepoName("My Project")).toBe("My-Project");
    expect(sanitizeRepoName("../victim/private")).toBe("victim-private");
    expect(sanitizeRepoName("..")).toBe("repo");
    expect(sanitizeRepoName(".hidden")).toBe("hidden");
    expect(sanitizeRepoName("hello-world")).toBe("hello-world");
    expect(sanitizeRepoName("")).toBe("repo");
    expect(sanitizeRepoName(undefined)).toBe("repo");
    // Whatever it returns is, by construction, safe to hand to pathOf.
    for (const raw of ["../../etc/passwd", "a/b/c", " ", "----", "%2e%2e%2f"]) {
      expect(isSafePathSegment(sanitizeRepoName(raw))).toBe(true);
    }
  });
});

describe("git.pathOf asserts containment (#138 sink layer)", () => {
  const git = new GitService("/data/repos");

  it("returns the ordinary path for ordinary names", () => {
    expect(git.pathOf("alice", "clawhub")).toBe("/data/repos/alice/clawhub.git");
  });

  it("throws on a SIDEWAYS traversal that stays inside basePath", () => {
    // The real #138 payload. The single `..` cancels the attacker's own
    // namespace segment, so the result is `/data/repos/victim/private-repo.git`
    // — still under basePath. A plain `startsWith(base)` containment assert
    // passes this; the tenant boundary is the DIRECTORY LEVEL, not the root.
    expect(path.resolve("/data/repos", "mallory", "../victim/private-repo.git"))
      .toBe("/data/repos/victim/private-repo.git");
    expect(() => git.pathOf("mallory", "../victim/private-repo")).toThrowError(/invalid repo path segment/);
  });

  it("throws on an escape out of basePath entirely", () => {
    expect(() => git.pathOf("mallory", "../../etc/evil")).toThrowError(/invalid repo path segment/);
    expect(() => git.pathOf("../..", "x")).toThrowError(/invalid namespace path segment/);
    expect(() => git.pathOf("mallory", "/etc/passwd")).toThrowError(/invalid repo path segment/);
    expect(() => git.pathOf("mallory", "..")).toThrowError(/invalid repo path segment/);
    expect(() => git.pathOf("", "x")).toThrowError(/invalid namespace path segment/);
    expect(() => git.pathOf("mallory", "a\0b")).toThrowError(/invalid repo path segment/);
  });

  it("still tolerates historical names that are odd but safe on disk", () => {
    // Weaker than isSafePathSegment ON PURPOSE — this runs on every existing
    // row, and a legacy GitLab import may hold `My Project`.
    expect(new GitService("/data/repos/").pathOf("alice", "My Project")).toBe("/data/repos/alice/My Project.git");
    expect(git.pathOf("alice", "a..b")).toBe("/data/repos/alice/a..b.git");
  });
});

describe.skipIf(!hasTestDb)("import + fork reject a traversal repo name end-to-end (#138)", () => {
  let base: string;
  let git: GitService;
  let attacker: { id: string; username: string };
  let victim: { id: string; username: string };
  let victimRepo: { id: string; name: string };
  let srcRepo: { id: string; name: string };

  function app(): Hono {
    const a = new Hono();
    a.route("/api/v1/repos", createForkRoutes(db, git, {} as EventBus));
    a.route("/api/v1/repos", createCodeRoutes(db, git));
    a.route("/api/v1/migrate", createMigrationRoutes(db, git));
    a.onError(errorHandler);
    return a;
  }
  const asUser = (u: { id: string }) => ({ authorization: `Bearer ${signToken({ kind: "user", userId: u.id, email: `${u.id}@t.co` })}` });

  async function mkUser(tag: string) {
    const username = `t138${tag}${S}`;
    const [u] = await db.insert(users).values({ email: `${username}@t.co`, username, passwordHash: "x" }).returning();
    return { id: u.id, username };
  }
  async function mkRepo(tag: string, owner: { id: string; username: string }, isPublic: boolean) {
    const name = `r138${tag}${S}`;
    const [r] = await db.insert(repositories).values({
      name, namespaceType: "user", namespaceId: owner.id, defaultBranch: "main", isPublic,
    }).returning();
    await git.initBare(owner.username, name);
    return { id: r.id, name };
  }
  // Seed the FIRST commit of a bare repo. commitBlobs needs an existing base
  // commit, so the root commit is authored with plumbing here.
  async function seed(owner: { username: string }, repo: string, file: string, content: string) {
    const dir = git.pathOf(owner.username, repo);
    const run = (args: string[], input?: string) => new Promise<string>((resolve, reject) => {
      const child = spawn("git", ["-C", dir, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, GIT_INDEX_FILE: path.join(dir, `idx-${S}`), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.co" },
      });
      let out = "", err = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { err += d; });
      child.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || String(code))));
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
    const blob = await run(["hash-object", "-w", "--stdin"], content);
    await run(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`]);
    const tree = await run(["write-tree"]);
    const commit = await run(["commit-tree", tree, "-m", "seed"]);
    await run(["update-ref", "refs/heads/main", commit]);
  }
  const exists = (p: string) => access(p).then(() => true, () => false);

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-138-"));
    git = new GitService(base);
    attacker = await mkUser("mal");
    victim = await mkUser("vic");
    // A PRIVATE repo with real content, so a successful traversal would return
    // something unmistakable rather than an empty-repo error.
    victimRepo = await mkRepo("priv", victim, false);
    await seed(victim, victimRepo.name, "secret.txt", "VICTIM-PRIVATE-SECRET-138\n");
    // A public repo the attacker may legitimately fork.
    srcRepo = await mkRepo("pub", victim, true);
    await seed(victim, srcRepo.name, "README.md", "hello\n");
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  it("POST /migrate/github 400s a traversal targetRepoName and creates no row", async () => {
    const evil = `../${victim.username}/${victimRepo.name}`;
    const res = await app().request("/api/v1/migrate/github", {
      method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
      body: JSON.stringify({ sourceOwner: "octocat", sourceRepo: "Hello-World", targetNamespace: attacker.username, targetRepoName: evil }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toMatch(/targetRepoName/);
    expect(await db.select().from(repositories).where(eq(repositories.name, evil))).toEqual([]);
  });

  it("POST /migrate/github 400s a traversal sourceRepo even with targetRepoName omitted", async () => {
    // Both halves of `targetRepoName ?? sourceRepo` are request fields, so
    // validating only the first closes nothing.
    const res = await app().request("/api/v1/migrate/github", {
      method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
      body: JSON.stringify({ sourceOwner: "octocat", sourceRepo: `../${victim.username}/${victimRepo.name}`, targetNamespace: attacker.username }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toMatch(/sourceRepo/);
  });

  it("POST /migrate/bitbucket 400s a traversal repoSlug / targetRepoName", async () => {
    for (const body of [
      { username: "u", appPassword: "p", workspace: "ws", repoSlug: "../x/y" },
      { username: "u", appPassword: "p", workspace: "ws", repoSlug: "ok", targetRepoName: "../x/y" },
    ]) {
      const res = await app().request("/api/v1/migrate/bitbucket", {
        method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
        body: JSON.stringify({ ...body, targetNamespace: attacker.username }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("POST /migrate/gitlab 400s a traversal targetRepoName but keeps slash-bearing projectPath legal", async () => {
    const res = await app().request("/api/v1/migrate/gitlab", {
      method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
      body: JSON.stringify({ gitlabToken: "t", projectPath: "group/sub/proj", targetNamespace: attacker.username, targetRepoName: "../x/y" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toMatch(/targetRepoName/);
  });

  it("POST /:ns/:repo/fork 400s a traversal name, writes nothing to disk, inserts no row", async () => {
    const outside = path.resolve(base, "..", `pwn138${S}`);
    const res = await app().request(`/api/v1/repos/${victim.username}/${srcRepo.name}/fork`, {
      method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
      body: JSON.stringify({ name: `../../${path.basename(outside)}` }),
    });
    expect(res.status).toBe(400);
    expect(await exists(`${outside}.git`)).toBe(false);
    expect(await db.select().from(repositories).where(and(
      eq(repositories.namespaceId, attacker.id), eq(repositories.forkOfRepoId, srcRepo.id),
    ))).toEqual([]);
  });

  it("POST /:ns/:repo/fork still works with an ordinary name", async () => {
    const name = `fork138ok${S}`;
    const res = await app().request(`/api/v1/repos/${victim.username}/${srcRepo.name}/fork`, {
      method: "POST", headers: { ...asUser(attacker), "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    expect(res.status).toBe(201);
    expect(await exists(path.join(base, attacker.username, `${name}.git`))).toBe(true);
  });

  it("a planted traversal row can no longer read the victim's private blob (sink layer)", async () => {
    // The row the boundary now refuses to create — planted directly, standing in
    // for a pre-fix row on a deployed instance or the next unguarded creation
    // site. The attacker legitimately OWNS it, so every authorization check
    // passes; only pathOf's containment assert is between them and the bytes.
    const evil = `../${victim.username}/${victimRepo.name}`;
    const [planted] = await db.insert(repositories).values({
      name: evil, namespaceType: "user", namespaceId: attacker.id, defaultBranch: "main", isPublic: false,
    }).returning();
    try {
      // Sanity: the victim's content IS readable through the legitimate path,
      // so a 404 below means containment fired, not that the fixture is empty.
      const own = await git.fileBytesAt(victim.username, victimRepo.name, "main", "secret.txt");
      expect(own?.toString()).toContain("VICTIM-PRIVATE-SECRET-138");

      const res = await app().request(
        `/api/v1/repos/${attacker.username}/${encodeURIComponent(evil)}/blob?ref=main&path=secret.txt`,
        { headers: asUser(attacker) },
      );
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("VICTIM-PRIVATE-SECRET-138");
    } finally {
      await db.delete(repositories).where(eq(repositories.id, planted.id));
    }
  });
});
