import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { testDb as db, hasTestDb } from "./test-db.js";
import { branches, changes, crossRepoProposals, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { acceptCrossRepoProposal, createCrossRepoProposal } from "../src/services/forks.js";

// #127 — acceptCrossRepoProposal was the ONE `insert(changes)` site that never
// ran the post-push derivation: it copied the SOURCE row's metadata verbatim
// (changedPaths computed against the fork's base, no computedRisk → gate pinned
// at the fail-closed `high`, no verifyTier → the privileged `dind` verify
// fallback, no reviewBrief → the proposer picks what the reviewer sees) and
// silently discarded `targetBranch` (the Change merges into the repo default
// regardless of what both UIs advertised). This is the one path importing
// commits authored in a repo the target's maintainers do not control, so the
// re-derivation must run against the TARGET.

const S = Date.now();

describe.skipIf(!hasTestDb)("cross-repo proposal accept re-derives against the target (#127)", () => {
  let base: string;
  let work: string;
  let git: GitService;
  let ns: string;
  let srcRepoName: string, targetRepoName: string;
  let srcRepoId: string, targetRepoId: string;
  let uid: string;
  let featureHead: string;
  const events = { publish: async () => {} } as never;

  async function commitAll(msg: string): Promise<string> {
    const g = simpleGit(work);
    await g.add(["-A"]);
    await g.commit(msg);
    return (await g.revparse(["HEAD"])).trim();
  }

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-xrepo-"));
    git = new GitService(path.join(base, "repos"));

    const [u] = await db.insert(users).values({ email: `xr-${S}@t.co`, username: `xru${S}`, passwordHash: "x" }).returning();
    uid = u.id;
    ns = u.username!;
    targetRepoName = `xrtarget${S}`;
    srcRepoName = `xrsrc${S}`;
    const [target] = await db.insert(repositories).values({
      name: targetRepoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "main",
    }).returning();
    targetRepoId = target.id;
    await git.initBare(ns, targetRepoName);

    // One shared worktree seeds both repos with a common T0, then the SOURCE
    // (the "fork") advances its own default branch past the target's.
    work = path.join(base, "work");
    await mkdir(work, { recursive: true });
    const g = simpleGit(work);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(work, "README.md"), "# repo\n");
    const t0 = await commitAll("init");
    await g.raw(["push", "--force", git.pathOf(ns, targetRepoName), "HEAD:refs/heads/main"]);
    await db.insert(branches).values({ repoId: targetRepoId, name: "main", headCommit: t0 }).onConflictDoNothing();

    const [src] = await db.insert(repositories).values({
      name: srcRepoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "main",
      forkOfRepoId: targetRepoId,
    }).returning();
    srcRepoId = src.id;
    await git.initBare(ns, srcRepoName);

    // The fork's trunk gains a SENSITIVE commit the target never saw — under
    // the verbatim copy this file was invisible to the target's gate while
    // still being merged.
    await mkdir(path.join(work, "deploy"), { recursive: true });
    await writeFile(path.join(work, "deploy/x.sql"), "-- deploy sql\n");
    await commitAll("fork trunk work");
    await g.raw(["push", "--force", git.pathOf(ns, srcRepoName), "HEAD:refs/heads/main"]);

    await g.checkoutLocalBranch("feature");
    await writeFile(path.join(work, "feature.ts"), "export const f = 1;\n");
    featureHead = await commitAll("Add feature\n\nIntent: Add the feature\nRisk: low");
    await g.raw(["push", "--force", git.pathOf(ns, srcRepoName), "HEAD:refs/heads/feature"]);
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  async function insertSourceChange(branch: string): Promise<string> {
    const [row] = await db.insert(changes).values({
      repoId: srcRepoId, branch, headCommit: featureHead,
      intent: "Add the feature", risk: "low",
      // As post-push in the SOURCE would have stored them: fork-base-relative.
      scope: ["feature.ts"], changedPaths: ["feature.ts"], reviewFocus: [], trailers: {},
      openedByUserId: uid, status: "pending",
    }).returning();
    return row.id;
  }

  it("rejects a proposal that targets anything but the target's default branch, writing no row", async () => {
    const changeId = await insertSourceChange("feature");
    await expect(createCrossRepoProposal(db, changeId, targetRepoId, "release-1.4"))
      .rejects.toThrow(/unsupported_target_branch/);
    expect((await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, changeId))).length).toBe(0);
    await db.delete(changes).where(eq(changes.id, changeId));
  });

  it("accept materializes a Change with metadata derived against the TARGET, not copied", async () => {
    const changeId = await insertSourceChange("feature");
    await createCrossRepoProposal(db, changeId, targetRepoId, "main");
    const prop = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, changeId)))[0];

    const { changeId: newChangeId } = await acceptCrossRepoProposal(db, git, events, prop.id);
    const row = (await db.select().from(changes).where(eq(changes.id, newChangeId)))[0];
    expect(row.repoId).toBe(targetRepoId);
    // Derived vs the target's base — the fork-trunk sensitive commit is IN the
    // set the gate reads (the source row said only feature.ts).
    expect(row.changedPaths).toEqual(expect.arrayContaining(["deploy/x.sql", "feature.ts"]));
    // The gate no longer rides the null→high fallback: risk is computed, and
    // the imported `.sql` floors it at high with an explainable reason.
    expect(row.computedRisk).toBe("high");
    expect((row.riskReasons as string[]).join(" ")).toMatch(/sensitive/i);
    // No privileged dind fallback for imported code: the tier is computed.
    expect(row.verifyTier).not.toBeNull();
    // The deterministic focus floor ran — the proposer no longer picks what the
    // reviewer sees.
    expect(row.reviewBrief).not.toBeNull();
    // No pipelines on the target → skipped, so ciRequired can be satisfied.
    expect(row.ciStatus).toBe("skipped");
  });

  it("accept re-validates against the target's CURRENT default branch", async () => {
    const changeId = await insertSourceChange("feature-b");
    await createCrossRepoProposal(db, changeId, targetRepoId, "main");
    const prop = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, changeId)))[0];

    await db.update(repositories).set({ defaultBranch: "trunk" }).where(eq(repositories.id, targetRepoId));
    try {
      await expect(acceptCrossRepoProposal(db, git, events, prop.id)).rejects.toThrow(/unsupported_target_branch/);
      // No Change materialized in the target for this proposal.
      expect((await db.select().from(changes).where(and(
        eq(changes.repoId, targetRepoId), eq(changes.branch, `proposal-${prop.id}`),
      ))).length).toBe(0);
    } finally {
      await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, targetRepoId));
    }
  });
});
