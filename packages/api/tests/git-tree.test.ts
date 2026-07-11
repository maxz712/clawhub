import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";

// Covers the code-browsing plumbing behind /tree and /blob.

const NS = "test-ns";
const REPO = "tree-repo";

let base: string;
let git: GitService;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-tree-test-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "t").then(() => g.addConfig("user.email", "t@t"));
  await mkdir(path.join(work, "src"));
  await writeFile(path.join(work, "README.md"), "# hi\n");
  await writeFile(path.join(work, "zz.txt"), "z\n");
  await writeFile(path.join(work, "src", "a name with spaces.ts"), "export {}\n");
  await g.add(".");
  await g.commit("seed");
  await g.push([git.pathOf(NS, REPO), "main"]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("GitService.listTree", () => {
  it("lists the root with directories first", async () => {
    const entries = await git.listTree(NS, REPO, "main");
    expect(entries.map(e => `${e.type}:${e.name}`)).toEqual([
      "dir:src", "file:README.md", "file:zz.txt",
    ]);
    expect(entries.find(e => e.name === "README.md")?.size).toBe(5);
    expect(entries.find(e => e.name === "src")?.size).toBeNull();
  });

  it("lists a subdirectory and keeps full paths, including names with spaces", async () => {
    const entries = await git.listTree(NS, REPO, "main", "src");
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("a name with spaces.ts");
    expect(entries[0].path).toBe("src/a name with spaces.ts");
  });

  it("throws for a missing path", async () => {
    await expect(git.listTree(NS, REPO, "main", "no/such/dir")).rejects.toBeDefined();
  });
});

describe("GitService.repoStats", () => {
  it("counts files and sums blob sizes recursively", async () => {
    // README.md (5 bytes) + zz.txt (2 bytes) + src/a name with spaces.ts (10 bytes) = 17 bytes, 3 files.
    const stats = await git.repoStats(NS, REPO, "main");
    expect(stats.fileCount).toBe(3);
    expect(stats.totalSizeBytes).toBe(5 + 2 + 10);
  });

  it("returns zeros for a bad ref instead of throwing", async () => {
    await expect(git.repoStats(NS, REPO, "0".repeat(40))).resolves.toEqual({ fileCount: 0, totalSizeBytes: 0 });
  });

  it("returns zeros for an unborn/empty repo", async () => {
    const emptyRepo = "empty-stats-repo";
    await git.initBare(NS, emptyRepo);
    await expect(git.repoStats(NS, emptyRepo, "main")).resolves.toEqual({ fileCount: 0, totalSizeBytes: 0 });
  });
});

describe("GitService.mergeBase", () => {
  it("returns the common ancestor and null on garbage", async () => {
    const head = await git.headCommit(NS, REPO, "main");
    expect(await git.mergeBase(NS, REPO, "main", head)).toBe(head);
    expect(await git.mergeBase(NS, REPO, "main", "0".repeat(40))).toBeNull();
  });
});

// lastCommitsForTree resolves the most-recent commit touching each immediate
// child of a directory in ONE `git log` — these tests build a multi-commit
// history and assert the per-entry attribution, "first touch wins" ordering,
// space-containing paths, and rename handling.
describe("GitService.lastCommitsForTree", () => {
  const LC_NS = "lc-ns";
  const LC_REPO = "lc-repo";
  let lcBase: string;
  let lcGit: GitService;

  beforeAll(async () => {
    lcBase = await mkdtemp(path.join(tmpdir(), "clawhub-lc-test-"));
    lcGit = new GitService(path.join(lcBase, "repos"));
    await lcGit.initBare(LC_NS, LC_REPO);

    const work = path.join(lcBase, "work");
    await mkdir(work);
    const g = simpleGit(work);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t").then(() => g.addConfig("user.email", "t@t"));

    // c1: seed README + src/a.ts + a dir entry via src/keep.ts
    await mkdir(path.join(work, "src"));
    await writeFile(path.join(work, "README.md"), "# v1\n");
    await writeFile(path.join(work, "src", "a.ts"), "export const a = 1\n");
    await writeFile(path.join(work, "src", "keep.ts"), "export const k = 1\n");
    await writeFile(path.join(work, "old name.ts"), "export const o = 1\n");
    await g.add(".");
    await g.commit("c1 seed");

    // c2: touch only README → README's last commit is c2, src/a.ts stays c1
    await writeFile(path.join(work, "README.md"), "# v2\n");
    await g.add(".");
    await g.commit("c2 readme");

    // c3: rename a top-level file → the directory entry "new name.ts" appears here
    await g.mv("old name.ts", "new name.ts");
    await g.commit("c3 rename");

    // c4: add a file under src → bumps the src/ directory entry to c4
    await writeFile(path.join(work, "src", "b.ts"), "export const b = 1\n");
    await g.add(".");
    await g.commit("c4 add src/b");

    await g.push([lcGit.pathOf(LC_NS, LC_REPO), "main"]);
  });

  afterAll(async () => {
    await rm(lcBase, { recursive: true, force: true });
  });

  it("attributes the most-recent touching commit per root entry", async () => {
    const names = (await lcGit.listTree(LC_NS, LC_REPO, "main")).map(e => e.name);
    const m = await lcGit.lastCommitsForTree(LC_NS, LC_REPO, "main", "", names);
    // README touched last in c2; the "src" dir entry bumped to c4 by src/b.ts;
    // the renamed file shows up under its new name in c3.
    expect(m.get("README.md")?.message).toBe("c2 readme");
    expect(m.get("src")?.message).toBe("c4 add src/b");
    expect(m.get("new name.ts")?.message).toBe("c3 rename");
    // Every entry carries a sha + ISO authoredAt.
    expect(m.get("README.md")?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.get("README.md")?.authoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("attributes immediate children inside a subdirectory", async () => {
    const names = (await lcGit.listTree(LC_NS, LC_REPO, "main", "src")).map(e => e.name);
    const m = await lcGit.lastCommitsForTree(LC_NS, LC_REPO, "main", "src", names);
    // a.ts/keep.ts only touched in c1; b.ts added in c4.
    expect(m.get("a.ts")?.message).toBe("c1 seed");
    expect(m.get("keep.ts")?.message).toBe("c1 seed");
    expect(m.get("b.ts")?.message).toBe("c4 add src/b");
  });

  it("returns an empty map for no names and ignores unknown names", async () => {
    expect((await lcGit.lastCommitsForTree(LC_NS, LC_REPO, "main", "", [])).size).toBe(0);
    const m = await lcGit.lastCommitsForTree(LC_NS, LC_REPO, "main", "", ["does-not-exist"]);
    expect(m.size).toBe(0);
  });

  it("returns an empty map for a bad ref instead of throwing", async () => {
    await expect(lcGit.lastCommitsForTree(LC_NS, LC_REPO, "0".repeat(40), "", ["README.md"]))
      .resolves.toEqual(new Map());
  });
});
