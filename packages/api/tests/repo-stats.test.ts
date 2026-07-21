import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";

// Coverage for GitService.stats() — the repo metadata surfaced in Settings (#33):
// on-disk object size, commit count, and file count at a ref. Runs against a real
// bare repo so the git plumbing (count-objects / rev-list / ls-tree) is exercised
// end to end.

const NS = "test-ns";
const REPO = "stats-repo";

let base: string;
let git: GitService;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-stats-test-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  // Seed main with two commits touching three distinct files.
  const work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "main"]);
  await g.addConfig("user.name", "test").then(() => g.addConfig("user.email", "test@test"));

  await writeFile(path.join(work, "a.txt"), "alpha\n");
  await writeFile(path.join(work, "b.txt"), "bravo\n");
  await g.add(".").then(() => g.commit("first commit"));

  await mkdir(path.join(work, "sub"));
  await writeFile(path.join(work, "sub", "c.txt"), "charlie\n");
  await g.add(".").then(() => g.commit("second commit"));

  await g.push(["--all", git.pathOf(NS, REPO)]);
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("GitService.stats", () => {
  it("reports commit count, file count, and a positive on-disk size", async () => {
    const s = await git.stats(NS, REPO, "main");
    expect(s.commits).toBe(2); // two commits on main
    expect(s.files).toBe(3);   // a.txt, b.txt, sub/c.txt
    expect(s.sizeBytes).not.toBeNull();
    expect(s.sizeBytes as number).toBeGreaterThan(0);
  });

  it("returns null legs for an unresolvable ref without throwing (size still resolves)", async () => {
    const s = await git.stats(NS, REPO, "does-not-exist");
    expect(s.commits).toBeNull();
    expect(s.files).toBeNull();
    // Size is ref-independent (whole object store), so it still resolves.
    expect(s.sizeBytes).not.toBeNull();
  });

  it("rejects an option-like ref instead of injecting it as a git flag", async () => {
    const s = await git.stats(NS, REPO, "--all");
    expect(s.commits).toBeNull();
    expect(s.files).toBeNull();
  });

  it("returns nulls for commits/files on a fresh empty repo (no commits yet)", async () => {
    await git.initBare(NS, "empty-repo");
    const s = await git.stats(NS, "empty-repo", "main");
    expect(s.commits).toBeNull();
    expect(s.files).toBeNull();
    // count-objects works on an empty repo; size is 0.
    expect(s.sizeBytes).toBe(0);
  });
});
