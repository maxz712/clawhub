import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";

// The "Update branch" git plumbing: bring a change head current with its base
// WITHOUT moving the base ref (the reverse of mergeInto/rebaseInto). Runs against
// a real bare repo. Topology:
//   main:    B1 --------- B2   (a.txt edited on main)
//               \
//   feature:     C1            (adds f.txt — clean vs B2)
//   conflict:    G1            (edits a.txt — conflicts with B2)

const NS = "test-ns";
const REPO = "ub-repo";

let base: string;
let git: GitService;
let B2: string, C1: string, G1: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-ub-test-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "test"); await g.addConfig("user.email", "test@test");
  // B1
  await writeFile(path.join(work, "a.txt"), "base\n"); await g.add("."); await g.commit("base commit");
  // feature (C1) from B1 — adds a distinct file, no overlap with the base edit
  await g.checkoutLocalBranch("feature"); await writeFile(path.join(work, "f.txt"), "feature\n"); await g.add("."); await g.commit("feature commit");
  // conflict (G1) from B1 — edits the SAME file main will edit
  await g.checkout("main"); await g.checkoutLocalBranch("conflict"); await writeFile(path.join(work, "a.txt"), "base\nfeature-line\n"); await g.add("."); await g.commit("conflict commit");
  // advance main to B2 — edits a.txt
  await g.checkout("main"); await writeFile(path.join(work, "a.txt"), "base\nmain-line\n"); await g.add("."); await g.commit("main advance");
  await g.push(["--all", git.pathOf(NS, REPO)]);

  B2 = await git.headCommit(NS, REPO, "main");
  C1 = await git.headCommit(NS, REPO, "feature");
  G1 = await git.headCommit(NS, REPO, "conflict");
});

afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe("isAncestor", () => {
  it("is false when the change is behind base, true for the merge-base + self", async () => {
    expect(await git.isAncestor(NS, REPO, B2, C1)).toBe(false); // base is NOT an ancestor of a behind change
    const mb = await git.mergeBase(NS, REPO, B2, C1);
    expect(await git.isAncestor(NS, REPO, mb!, C1)).toBe(true);  // the fork point is
    expect(await git.isAncestor(NS, REPO, C1, C1)).toBe(true);   // equal
  });
});

describe("trialMerge (conflict gate)", () => {
  it("is clean for a disjoint change, conflicts for a same-file edit", async () => {
    expect((await git.trialMerge(NS, REPO, B2, C1)).conflicts).toBe(false);
    expect((await git.trialMerge(NS, REPO, B2, G1)).conflicts).toBe(true);
  });
});

describe("updateBranchInto (merge base INTO change, base untouched)", () => {
  it("makes a merge commit with parents [head, base] and keeps base put", async () => {
    const mainBefore = await git.headCommit(NS, REPO, "main");
    const newHead = await git.updateBranchInto(NS, REPO, C1, B2, "merge", "bot", "bot@clawhub", "Merge main into feature");
    expect(newHead).toMatch(/^[0-9a-f]{40}$/);
    const parents = (await git.open(NS, REPO).raw(["rev-list", "--parents", "-n", "1", newHead])).trim().split(/\s+/);
    expect(parents).toEqual([newHead, C1, B2]); // first parent is the change head, second is base
    expect(await git.headCommit(NS, REPO, "main")).toBe(mainBefore); // BASE UNTOUCHED
    const files = await git.open(NS, REPO).raw(["ls-tree", "-r", "--name-only", newHead]);
    expect(files).toContain("f.txt"); // the change's file
    expect(files).toContain("a.txt"); // the base's edit merged in
    expect(await git.isAncestor(NS, REPO, B2, newHead)).toBe(true); // now current with base
  });
});

describe("updateBranchInto (rebase change ONTO base, base untouched)", () => {
  it("replays the change's commits onto base with no merge commit", async () => {
    const mainBefore = await git.headCommit(NS, REPO, "main");
    const newHead = await git.updateBranchInto(NS, REPO, C1, B2, "rebase", "bot", "bot@clawhub", "");
    const parents = (await git.open(NS, REPO).raw(["rev-list", "--parents", "-n", "1", newHead])).trim().split(/\s+/);
    expect(parents).toEqual([newHead, B2]); // linear: single parent = base
    expect(await git.commitMessage(NS, REPO, newHead)).toBe("feature commit"); // original message preserved
    expect(await git.headCommit(NS, REPO, "main")).toBe(mainBefore); // BASE UNTOUCHED
    expect(await git.isAncestor(NS, REPO, B2, newHead)).toBe(true);
  });
});
