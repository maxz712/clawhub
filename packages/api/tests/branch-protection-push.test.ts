import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import { GitService } from "../src/services/git.js";
import { processPush } from "../src/services/post-push.js";
import { branches } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// #189 — push-time branch protection was unenforceable on all three legs:
// (1) the force-push probe used `raw(["merge-base", "--is-ancestor", ...])` +
//     catch, but simple-git's raw RESOLVES on is-ancestor's exit-1 (no stderr)
//     — the codebase's own isAncestor comment documents the trap — so the
//     catch was unreachable and blockForcePush rejected no push, ever;
// (2) neither control restored the ref git had already applied (post-push runs
//     AFTER the receive), so even a firing gate changed nothing on disk;
// (3) blockDeletion threw BEFORE deleting the `branches` row, so the phantom
//     row was re-inferred as "deleted by this push" on every later push — a
//     permanent per-repo poison pill.
//
// These drive the REAL processPush against a REAL temp git repo (the
// post-push-secret-scan.test.ts pattern). The DB is a table-aware fake: the
// `branches` select yields the protection row, everything else yields [] — the
// gates under test fire and throw before any transactional write.

const NS = "bp-push-ns";
const REPO = "bp-push-repo";

const fakeDb = {
  select: () => ({
    from: (t: unknown) => ({
      where: () => ({
        limit: async () => (t === branches
          ? [{ protection: { blockForcePush: true, blockDeletion: true }, headCommit: "x" }]
          : []),
      }),
    }),
  }),
} as unknown as DB;

let base: string;
let git: GitService;
let work: string;

async function pushRef(ref: string, sha: string) {
  await simpleGit(work).raw(["push", "--force", git.pathOf(NS, REPO), `${sha}:${ref}`]);
}

async function commitFile(name: string, content: string, msg: string): Promise<string> {
  const g = simpleGit(work);
  await writeFile(path.join(work, name), content);
  await g.add(["-A"]);
  await g.commit(msg);
  return (await g.revparse(["HEAD"])).trim();
}

async function runPush(ref: string, oldSha: string, newSha: string): Promise<Error | null> {
  return processPush({
    db: fakeDb,
    git,
    changeRefs: { set: async () => {} } as never,
    events: { publish: async () => {} } as never,
    namespace: NS,
    repoName: REPO,
    repoId: "00000000-0000-0000-0000-000000000001",
    defaultBranch: "master",
    actor: { kind: "user", userId: "00000000-0000-0000-0000-000000000002" },
    pushedRefs: [{ ref, oldSha, newSha }],
  }).then(() => null, (e: Error) => e);
}

async function serverSha(ref: string): Promise<string | null> {
  try { return (await git.open(NS, REPO).raw(["rev-parse", ref])).trim(); }
  catch { return null; }
}

let c1: string; // shared trunk commit
let c2: string; // fast-forward of c1
let c3: string; // fork off c1 — NOT a descendant of c2

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "clawhub-bp-push-"));
  git = new GitService(path.join(base, "repos"));
  await git.initBare(NS, REPO);

  work = path.join(base, "work");
  await mkdir(work, { recursive: true });
  const g = simpleGit(work);
  await g.init(["-b", "master"]);
  await g.addConfig("user.name", "t");
  await g.addConfig("user.email", "t@t");
  c1 = await commitFile("README.md", "# repo\n", "init");
  c2 = await commitFile("README.md", "# repo\nmore\n", "ff");
  await g.raw(["checkout", "-b", "fork", c1]);
  c3 = await commitFile("other.md", "diverged\n", "diverged");
  await g.raw(["checkout", "master"]);
  // Seed the bare repo with all three commits so the gates (and isAncestor)
  // can resolve them server-side.
  await pushRef("refs/heads/master", c2);
  await pushRef("refs/heads/fork", c3);
});

afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

describe("blockForcePush actually fires and restores the ref (#189)", () => {
  it("git.isAncestor reports the FALSE case (a probe that always says ancestor is an absent check)", async () => {
    expect(await git.isAncestor(NS, REPO, c1, c2)).toBe(true);
    expect(await git.isAncestor(NS, REPO, c2, c3)).toBe(false);
  });

  it("rejects a non-fast-forward update and puts the ref back at oldSha", async () => {
    // Simulate the receive: git applied the force-push before post-push runs.
    await pushRef("refs/heads/protected", c2);
    await pushRef("refs/heads/protected", c3);
    expect(await serverSha("refs/heads/protected")).toBe(c3);

    const err = await runPush("refs/heads/protected", c2, c3);
    expect(err?.message).toBe("branch protection forbids force-push");
    // The displaced commits are restored — "blocked" means blocked on disk.
    expect(await serverSha("refs/heads/protected")).toBe(c2);
  });

  it("lets a fast-forward update through the gate", async () => {
    await pushRef("refs/heads/protected2", c1);
    await pushRef("refs/heads/protected2", c2);

    const err = await runPush("refs/heads/protected2", c1, c2);
    // The fake DB makes the pipeline fall over downstream (the Change upsert
    // wants a real Postgres); all this asserts is that it got PAST the gate.
    expect(err?.message ?? "").not.toMatch(/branch protection/);
    expect(await serverSha("refs/heads/protected2")).toBe(c2);
  });
});

describe("blockDeletion restores the deleted ref (#189)", () => {
  it("rejects the deletion and resurrects the branch at its prior head", async () => {
    await pushRef("refs/heads/keepme", c2);
    // Simulate the receive applying the deletion before post-push runs.
    await git.open(NS, REPO).raw(["update-ref", "-d", "refs/heads/keepme"]);
    expect(await serverSha("refs/heads/keepme")).toBeNull();

    const err = await runPush("refs/heads/keepme", c2, "0".repeat(40));
    expect(err?.message).toBe("branch protection forbids deletion");
    // Restored BEFORE the throw: disk and the branches row stay consistent, so
    // the runner's priorHeads diff cannot re-infer this deletion forever (the
    // poison-pill wedge).
    expect(await serverSha("refs/heads/keepme")).toBe(c2);
  });
});
