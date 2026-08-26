import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";
import { processPush } from "../src/services/post-push.js";
import { admitMagicRefs } from "../src/services/ref-rewriter.js";
import { agents, branches, changes, repositories, users } from "../src/models/schema.js";
import { testDb, hasTestDb } from "./test-db.js";
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

  it("a REAL branch named magic/... takes the ordinary revert arm, not the retraction (#195 follow-up)", async () => {
    // "magic/" is not a reserved prefix — anyone can push refs/heads/magic/x.
    // Keyed on the branch NAME, the retraction arm was fail-open for exactly
    // this push: no Change row exists (admitMagicRefs never ran), so nothing
    // was retracted AND the on-disk ref revert was structurally skipped — the
    // credential stayed fetchable while the push was audited "rejected", and
    // the ref was re-discovered as new on every later push (repo wedge). The
    // gate must treat this like any other real branch: reject + revert on disk.
    const g = simpleGit(work);
    await g.checkout("master");
    await g.checkoutLocalBranch("magic/oops/branch");
    await writeFile(path.join(work, ".env"), `${SECRET}\n`);
    const sha = await pushBranch("magic/oops/branch", "Add config\n\nIntent: Add config\nRisk: low");

    const err = await runPush("magic/oops/branch", sha);
    expect(err?.message).toMatch(/^secret_detected:anthropic-key:\.env:1$/);
    // The else-arm's on-disk revert ran: the credential-bearing ref is GONE.
    const refs = await git.open(NS, REPO).raw(["for-each-ref", "--format=%(refname)", "refs/heads/"]);
    expect(refs).not.toContain("refs/heads/magic/oops/branch");
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

// #195 — the #130 follow-up. On the magic-ref path (`refs/for/<branch>`, the
// path every agent pushes on) the gate's ref revert targeted a synthetic
// `refs/heads/magic/...` name that never exists on disk, so a "rejected" push
// left the credential fetchable at refs/clawhub/changes/<id> and a zombie
// placeholder Change in the review queue. Needs a real Postgres: the retraction
// is a Change-row compensation for what admitMagicRefs allocated.
describe.skipIf(!hasTestDb)("the secret gate RETRACTS a magic-ref push's Change (#195)", () => {
  const db = testDb;
  const S = Date.now();
  let mbase: string;
  let mgit: GitService;
  let mwork: string;
  let ns: string, repoName: string, repoId: string, agentId: string;

  beforeAll(async () => {
    mbase = await mkdtemp(path.join(tmpdir(), "clawhub-magic-secret-"));
    mgit = new GitService(path.join(mbase, "repos"));

    const [u] = await db.insert(users).values({ email: `ms-${S}@t.co`, username: `msu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    const [a] = await db.insert(agents).values({
      name: `ms-agent-${S}`, tokenHash: "x", gitAuthorName: "ms-bot", gitAuthorEmail: "ms-bot@clawhub.test",
    }).returning();
    agentId = a.id;
    repoName = `msrepo${S}`;
    const [r] = await db.insert(repositories).values({
      name: repoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "master",
    }).returning();
    repoId = r.id;
    await mgit.initBare(ns, repoName);

    mwork = path.join(mbase, "work");
    await mkdir(mwork, { recursive: true });
    const g = simpleGit(mwork);
    await g.init(["-b", "master"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(mwork, "README.md"), "# repo\n");
    await g.add(["-A"]);
    await g.commit("init");
    const init = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", mgit.pathOf(ns, repoName), "HEAD:refs/heads/master"]);
    await db.insert(branches).values({ repoId, name: "master", headCommit: init }).onConflictDoNothing();
  });

  afterAll(async () => { if (mbase) await rm(mbase, { recursive: true, force: true }); });

  /** The runner's magic intake: admit the ref, drop it, hand processPush the synthetic branch. */
  async function magicPush(sha: string): Promise<{ err: Error | null; synthBranch: string; changeId: string }> {
    const admitted = await admitMagicRefs({
      db, git: mgit, namespace: ns, repoName,
      actor: { kind: "agent", agentId },
      refs: [{ ref: "refs/for/master", newSha: sha, targetBranch: "master" }],
    });
    await mgit.open(ns, repoName).raw(["update-ref", "-d", "refs/for/master"]).catch(() => {});
    const synthBranch = `magic/master/${sha.slice(0, 12)}`;
    const err = await processPush({
      db, git: mgit,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName, repoId, defaultBranch: "master",
      actor: { kind: "agent", agentId },
      // viaMagicRef mirrors the runner: the retraction arm dispatches on this
      // stamp, never on the "magic/" branch-name prefix (see the real-branch
      // case in the #130 suite).
      pushedRefs: [{ ref: `refs/heads/${synthBranch}`, oldSha: "0".repeat(40), newSha: sha, viaMagicRef: true }],
    }).then(() => null, (e: Error) => e);
    return { err, synthBranch, changeId: admitted[0].changeId };
  }

  it("retracts the Change: row, synthetic branch, change ref and stats bump all undone", async () => {
    const g = simpleGit(mwork);
    await g.checkoutLocalBranch("leaky");
    await writeFile(path.join(mwork, ".env"), `${SECRET}\n`);
    await g.add(["-A"]);
    await g.commit("Add config\n\nIntent: Add config\nRisk: low");
    const sha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", mgit.pathOf(ns, repoName), "HEAD:refs/for/master"]);

    const { err, synthBranch, changeId } = await magicPush(sha);
    expect(err?.message).toMatch(/^secret_detected:anthropic-key:\.env:1$/);

    // No zombie Change, no phantom branch row.
    expect((await db.select().from(changes).where(eq(changes.id, changeId))).length).toBe(0);
    expect((await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, synthBranch)))).length).toBe(0);
    // The credential is no longer reachable through any change ref.
    const refs = await mgit.open(ns, repoName).raw(["for-each-ref", "--format=%(refname)"]);
    expect(refs).not.toContain(`refs/clawhub/changes/${changeId}`);
    expect(refs).not.toContain("refs/for/master");
    // The changesOpened bump admitMagicRefs applied is undone.
    const stats = (await db.select({ stats: agents.stats }).from(agents).where(eq(agents.id, agentId)))[0].stats as { changesOpened?: number } | null;
    expect(stats?.changesOpened ?? 0).toBe(0);
  });

  it("a later clean magic push to the same repo opens a Change normally (no wedge)", async () => {
    const g = simpleGit(mwork);
    await g.checkout("master");
    await g.checkoutLocalBranch("clean-magic");
    await writeFile(path.join(mwork, "notes.md"), "no credentials here\n");
    await g.add(["-A"]);
    await g.commit("Add notes\n\nIntent: Add notes\nRisk: low");
    const sha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", mgit.pathOf(ns, repoName), "HEAD:refs/for/master"]);

    const { err, changeId } = await magicPush(sha);
    expect(err).toBeNull();
    const row = (await db.select().from(changes).where(eq(changes.id, changeId)))[0];
    expect(row).toBeTruthy();
    expect(row.intent).toBe("Add notes");
  });
});
