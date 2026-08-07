import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";
import { processPush } from "../src/services/post-push.js";
import type { DB } from "../src/models/db.js";

// #130 — the HARD secret gate used to read the agent-declared `Scope:` trailer
// (author-controlled) and to stop after 40 files. Both legs are trivially
// exploitable by the pusher, who on this platform is normally an LLM-driven
// agent writing its own trailers.
//
// These run the REAL `processPush` against a REAL temp git repo, because the
// whole defect is about WHICH path list the gate reads — a hand-written fixture
// of paths would just re-encode the assumption under test. The DB is a minimal
// fake: on the rejection path a HUMAN push touches Postgres exactly twice (the
// actor-name lookup + the branch-protection row), both `... .limit(1)` selects,
// so the guard runs in CI with no Postgres (mem: a guard that only runs when a
// DB happens to be provisioned is not a guard).
//
// Both hostile cases MUST fail if the fix is reverted — verified by stashing
// services/post-push.ts and re-running.

const NS = "secret-scan-ns";
const REPO = "secret-scan-repo";
const SECRET = `ANTHROPIC_API_KEY=sk-ant-${"a1B2c3D4e5".repeat(9)}`;

/** Chainable no-op stand-in for the two `select(...).from(...).where(...).limit(1)` reads. */
const fakeDb = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [] as unknown[] }) }) }),
} as unknown as DB;

let base: string;
let git: GitService;
let work: string;

async function pushBranch(branch: string, message: string): Promise<string> {
  const g = simpleGit(work);
  await g.add(["-A"]);
  await g.commit(message);
  await g.raw(["push", "--force", git.pathOf(NS, REPO), `HEAD:refs/heads/${branch}`]);
  return (await g.revparse(["HEAD"])).trim();
}

/** Drive the real pipeline for a branch push and return the error it threw (or null). */
async function runPush(branch: string, newSha: string): Promise<Error | null> {
  return processPush({
    db: fakeDb,
    git,
    changeRefs: {} as never,
    events: { publish: async () => {} } as never,
    namespace: NS,
    repoName: REPO,
    repoId: "00000000-0000-0000-0000-000000000001",
    defaultBranch: "master",
    actor: { kind: "user", userId: "00000000-0000-0000-0000-000000000002" },
    pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha }],
  }).then(() => null, (e: Error) => e);
}

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-secret-scan-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  work = path.join(base, "work");
  await mkdir(work, { recursive: true });
  const g = simpleGit(work);
  await g.init(["-b", "master"]);
  await g.addConfig("user.name", "t");
  await g.addConfig("user.email", "t@t");
  await writeFile(path.join(work, "README.md"), "# repo\n");
  await pushBranch("master", "init");
});

afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

describe("post-push hard secret gate reads git, not the Scope: trailer (#130)", () => {
  it("rejects a credential the commit's Scope: trailer omits", async () => {
    const g = simpleGit(work);
    await g.checkoutLocalBranch("hidden-scope");
    await writeFile(path.join(work, "README.md"), "# repo\nsome docs\n");
    await writeFile(path.join(work, ".env"), `${SECRET}\n`);
    const sha = await pushBranch("hidden-scope", [
      "Update readme",
      "",
      "Intent: Update readme",
      "Risk: low",
      "Scope: README.md", // .env deliberately omitted — this is the attack
    ].join("\n"));

    const err = await runPush("hidden-scope", sha);
    expect(err?.message).toMatch(/^secret_detected:anthropic-key:\.env:1$/);
  });

  it("deletes the rejected ref so the credential is not left fetchable", async () => {
    // The scan runs POST-receive: without the revert a "rejected" push still
    // leaves refs/heads/hidden-scope on the server pointing at the secret, AND
    // (since `priorHeads` comes from the branches TABLE, which a rejected push
    // never writes) that ref re-trips the gate on every later push, wedging the
    // repo. Asserted straight after the rejection above.
    const refs = await git.open(NS, REPO).raw(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
    expect(refs).not.toContain("refs/heads/hidden-scope");
    expect(refs).toContain("refs/heads/master"); // and it reverted only the offending ref
  });

  it("rejects a credential in the 50th changed file (no silent 40-file cap)", async () => {
    const g = simpleGit(work);
    await g.checkout("master");
    await g.checkoutLocalBranch("many-files");
    await mkdir(path.join(work, "src"), { recursive: true });
    for (let i = 1; i <= 60; i++) {
      const name = `src/f${String(i).padStart(2, "0")}.ts`;
      await writeFile(path.join(work, name), i === 50 ? `export const k = "${SECRET}";\n` : `export const n${i} = ${i};\n`);
    }
    // No Scope: trailer at all — the path list is honest and git-derived here,
    // so this leg isolates the cap from the trailer bug.
    const sha = await pushBranch("many-files", "Add sixty modules\n\nIntent: Add modules\nRisk: low");

    const err = await runPush("many-files", sha);
    expect(err?.message).toMatch(/^secret_detected:anthropic-key:src\/f50\.ts:1$/);
  });

  it("lets a clean push through (the gate is not just rejecting everything)", async () => {
    const g = simpleGit(work);
    await g.checkout("master");
    await g.checkoutLocalBranch("clean");
    await writeFile(path.join(work, "src-note.md"), "no credentials here\n");
    const sha = await pushBranch("clean", "Add note\n\nIntent: Add note\nRisk: low\nScope: src-note.md");

    const err = await runPush("clean", sha);
    // The fake DB makes the pipeline fall over further downstream (the Change
    // upsert wants a real Postgres); all this asserts is that it got PAST the
    // secret gate.
    expect(err?.message ?? "").not.toMatch(/secret_detected/);
  });

  it("still exempts test fixtures, so a repo can host tests for its own scanner", async () => {
    const g = simpleGit(work);
    await g.checkout("master");
    await g.checkoutLocalBranch("fixture");
    await mkdir(path.join(work, "tests"), { recursive: true });
    await writeFile(path.join(work, "tests/fixture.ts"), `const sample = "${SECRET}";\n`);
    const sha = await pushBranch("fixture", "Add scanner fixture\n\nIntent: Add fixture\nRisk: low");

    const err = await runPush("fixture", sha);
    expect(err?.message ?? "").not.toMatch(/secret_detected/);
  });
});
