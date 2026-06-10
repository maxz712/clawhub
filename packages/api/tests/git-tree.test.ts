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

describe("GitService.mergeBase", () => {
  it("returns the common ancestor and null on garbage", async () => {
    const head = await git.headCommit(NS, REPO, "main");
    expect(await git.mergeBase(NS, REPO, "main", head)).toBe(head);
    expect(await git.mergeBase(NS, REPO, "main", "0".repeat(40))).toBeNull();
  });
});
