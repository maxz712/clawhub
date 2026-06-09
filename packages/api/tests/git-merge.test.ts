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
