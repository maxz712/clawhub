import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";

// Regression coverage for the server-side merge plumbing. mergeInto once passed
// a bogus `--messages=<msg>` flag to `git merge-tree`, which made every merge
// 500 against real git. These tests run all three merge methods against a real
// bare repo.

const NS = "test-ns";
const REPO = "merge-repo";

let base: string;
let git: GitService;

async function commitOnBranch(workdir: string, branch: string, file: string, content: string, message: string): Promise<void> {
  const g = simpleGit(workdir);
  const branches = await g.branchLocal();
  if (branches.all.includes(branch)) await g.checkout(branch);
  else await g.checkoutLocalBranch(branch);
  await writeFile(path.join(workdir, file), content);
  await g.add(".");
  await g.commit(message);
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-git-test-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  // Seed: main with one commit, feature branched off it with one more commit.
  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "test").then(() => g.addConfig("user.email", "test@test"));
  await commitOnBranch(work, "main", "a.txt", "base\n", "base commit");
  await commitOnBranch(work, "feature", "b.txt", "feature\n", "feature commit");
  await g.push(["--all", git.pathOf(NS, REPO)]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("GitService merge methods", () => {
  it("mergeInto creates a two-parent merge commit and advances the base branch", async () => {
    const head = await git.headCommit(NS, REPO, "feature");
    const before = await git.headCommit(NS, REPO, "main");
    const sha = await git.mergeInto(NS, REPO, "main", head, "bot", "bot@clawhub", "Merge change: feature");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.headCommit(NS, REPO, "main")).toBe(sha);
    const parents = (await git.open(NS, REPO).raw(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/);
    expect(parents).toEqual([sha, before, head]);
    expect(await git.commitMessage(NS, REPO, sha)).toBe("Merge change: feature");
  });

  it("squashInto creates a single-parent commit with the feature tree", async () => {
    const work = path.join(base, "work");
    await commitOnBranch(work, "feature2", "c.txt", "squash me\n", "feature2 commit");
    await simpleGit(work).push([git.pathOf(NS, REPO), "feature2"]);

    const head = await git.headCommit(NS, REPO, "feature2");
    const before = await git.headCommit(NS, REPO, "main");
    const sha = await git.squashInto(NS, REPO, "main", head, "bot", "bot@clawhub", "Squashed: feature2");
    const parents = (await git.open(NS, REPO).raw(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/);
    expect(parents).toEqual([sha, before]);
    const files = await git.open(NS, REPO).raw(["ls-tree", "--name-only", sha]);
    expect(files).toContain("c.txt");
  });

  it("rebaseInto replays commits onto the base branch without merge commits", async () => {
    const work = path.join(base, "work");
    await commitOnBranch(work, "feature3", "d.txt", "rebase me\n", "feature3 commit");
    await simpleGit(work).push([git.pathOf(NS, REPO), "feature3"]);

    const head = await git.headCommit(NS, REPO, "feature3");
    const sha = await git.rebaseInto(NS, REPO, "main", head, "bot", "bot@clawhub");
    const parents = (await git.open(NS, REPO).raw(["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/);
    expect(parents).toHaveLength(2); // self + one parent: linear history
    expect(await git.commitMessage(NS, REPO, sha)).toBe("feature3 commit");
  });
});

// #147 — `git merge-tree --write-tree` on a conflict exits 1 with the CONFLICTED
// tree OID on stdout and NOTHING on stderr; simple-git only rejects on non-zero
// exit AND non-empty stderr, so the call RESOLVED and the conflicted tree (full
// of `<<<<<<<` markers) was committed to the default branch as a "successful"
// merge. These tests pin the fail-closed behavior for all four merge-tree sites.
describe("GitService merge methods fail closed on a conflict (#147)", () => {
  let conflictHead: string;

  beforeAll(async () => {
    const work = path.join(base, "work");
    // Both sides edit a.txt's one line: branch off the CURRENT main first, then
    // advance main — a guaranteed content conflict for every method.
    await commitOnBranch(work, "main", "a.txt", "mainline change\n", "main edits a.txt");
    const g = simpleGit(work);
    await g.raw(["checkout", "-B", "conflict", "main~1"]);
    await writeFile(path.join(work, "a.txt"), "conflicting change\n");
    await g.add(".");
    await g.commit("conflict edits a.txt");
    await g.push(["--force", "--all", git.pathOf(NS, REPO)]);
    conflictHead = await git.headCommit(NS, REPO, "conflict");
  });

  const noConflictMarkersAnywhere = async () => {
    // The property that actually matters: no commit reachable from ANY ref
    // carries a blob with conflict markers. `git grep` exits 1 (no match) with
    // empty stderr — the exact shape simple-git RESOLVES (the bug under test) —
    // so assert on the (empty) match list, not on a rejection.
    const revs = (await git.open(NS, REPO).raw(["rev-list", "--all"])).trim().split("\n").filter(Boolean);
    const out = await git.open(NS, REPO).raw(["grep", "-l", "<<<<<<<", ...revs]).catch(() => "");
    expect(out.trim()).toBe("");
  };

  it("mergeInto throws and leaves the base branch unmoved", async () => {
    const before = await git.headCommit(NS, REPO, "main");
    await expect(git.mergeInto(NS, REPO, "main", conflictHead, "bot", "bot@clawhub", "Merge change: conflict")).rejects.toThrow(/conflict/i);
    expect(await git.headCommit(NS, REPO, "main")).toBe(before);
    await noConflictMarkersAnywhere();
  });

  it("squashInto throws and leaves the base branch unmoved", async () => {
    const before = await git.headCommit(NS, REPO, "main");
    await expect(git.squashInto(NS, REPO, "main", conflictHead, "bot", "bot@clawhub", "Squashed: conflict")).rejects.toThrow(/conflict/i);
    expect(await git.headCommit(NS, REPO, "main")).toBe(before);
    await noConflictMarkersAnywhere();
  });

  it("rebaseInto throws and leaves the base branch unmoved", async () => {
    const before = await git.headCommit(NS, REPO, "main");
    await expect(git.rebaseInto(NS, REPO, "main", conflictHead, "bot", "bot@clawhub")).rejects.toThrow(/conflict/i);
    expect(await git.headCommit(NS, REPO, "main")).toBe(before);
    await noConflictMarkersAnywhere();
  });

  it("updateBranchInto throws on a content conflict for BOTH methods (docstring now true)", async () => {
    const baseSha = await git.headCommit(NS, REPO, "main");
    await expect(git.updateBranchInto(NS, REPO, conflictHead, baseSha, "merge", "bot", "bot@clawhub", "update")).rejects.toThrow(/conflict/i);
    await expect(git.updateBranchInto(NS, REPO, conflictHead, baseSha, "rebase", "bot", "bot@clawhub", "update")).rejects.toThrow(/conflict/i);
    await noConflictMarkersAnywhere();
  });

  it("a clean merge still passes through the same guard", async () => {
    const work = path.join(base, "work");
    await simpleGit(work).checkout("main"); // branch off main, not the conflict branch
    await commitOnBranch(work, "clean-after-guard", "e.txt", "clean\n", "clean commit");
    await simpleGit(work).push(["--force", git.pathOf(NS, REPO), "clean-after-guard"]);
    const head = await git.headCommit(NS, REPO, "clean-after-guard");
    const sha = await git.mergeInto(NS, REPO, "main", head, "bot", "bot@clawhub", "Merge change: clean");
    expect(await git.headCommit(NS, REPO, "main")).toBe(sha);
  });
});
