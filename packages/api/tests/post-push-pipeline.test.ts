import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, codeIndexShards, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { processPush } from "../src/services/post-push.js";

// Batch #196/#175/#186/#129 — post-push derivation correctness, driven through
// the REAL processPush over a REAL bare repo against a REAL Postgres, because
// every one of these defects lives in WHICH range/base the pipeline reads:
//   #196 — authoritative changedPaths/risk/tier were diffed two-dot against the
//          default-branch TIP, so trunk's own commits landed in the Change;
//   #175 — trailer metadata was aggregated over only the NEW commits, so a
//          bare fixup push erased declared Intent/Risk/Review-Focus;
//   #186 — indexRepoAtCommit's only automatic call site was inside a dead
//          `branch === defaultBranch` block, so /code/search stayed empty;
//   #129 — merge.yml adoption wholesale-replaced the policy blob, deleting
//          every key the DSL cannot express.

const S = Date.now();

describe.skipIf(!hasTestDb)("post-push pipeline derivation (#196/#175/#186/#129)", () => {
  let base: string;
  let work: string;
  let git: GitService;
  let ns: string, repoName: string, repoId: string;
  const userId = () => uid;
  let uid: string;

  async function commitAll(msg: string): Promise<string> {
    const g = simpleGit(work);
    await g.add(["-A"]);
    await g.commit(msg);
    return (await g.revparse(["HEAD"])).trim();
  }

  async function pushBranch(branch: string): Promise<string> {
    const g = simpleGit(work);
    const sha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", git.pathOf(ns, repoName), `HEAD:refs/heads/${branch}`]);
    return sha;
  }

  async function run(branch: string, oldSha: string, newSha: string) {
    await processPush({
      db, git,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName, repoId, defaultBranch: "main",
      actor: { kind: "user", userId: uid },
      pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha, newSha }],
    });
  }

  const changeRow = async (branch: string) =>
    (await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1))[0];

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-pp-pipeline-"));
    git = new GitService(path.join(base, "repos"));

    const [u] = await db.insert(users).values({ email: `pp-${S}@t.co`, username: `ppu${S}`, passwordHash: "x" }).returning();
    uid = u.id;
    ns = u.username!;
    repoName = `pprepo${S}`;
    const [r] = await db.insert(repositories).values({
      name: repoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "main",
    }).returning();
    repoId = r.id;
    await git.initBare(ns, repoName);

    work = path.join(base, "work");
    await mkdir(work, { recursive: true });
    const g = simpleGit(work);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(work, "README.md"), "# repo\nline\n");
    const init = await commitAll("init");
    await pushBranch("main");
    await db.insert(branches).values({ repoId, name: "main", headCommit: init }).onConflictDoNothing();
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  it("#196: a branch behind a diverged trunk derives changedPaths/risk/tier from the MERGE BASE", async () => {
    const g = simpleGit(work);
    // The Change: a one-line README edit branched from the current trunk tip.
    await g.raw(["checkout", "-B", "feat-behind", "main"]);
    await writeFile(path.join(work, "README.md"), "# repo\nedited\n");
    const head = await commitAll("Edit readme\n\nIntent: Edit the readme\nRisk: low");
    await pushBranch("feat-behind");

    // Trunk moves on: a migration + a large file land on main AFTER the fork
    // point — the steady state of an active repo (and what the Loop's cadence
    // manufactures on its own).
    await g.raw(["checkout", "main"]);
    await mkdir(path.join(work, "packages/api/drizzle"), { recursive: true });
    await writeFile(path.join(work, "packages/api/drizzle/0077_add_col.sql"), "ALTER TABLE x ADD COLUMN y int;\n");
    await writeFile(path.join(work, "big.ts"), Array.from({ length: 600 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    const trunkTip = await commitAll("trunk work");
    await pushBranch("main");
    await db.update(branches).set({ headCommit: trunkTip }).where(and(eq(branches.repoId, repoId), eq(branches.name, "main")));

    await run("feat-behind", "0".repeat(40), head);
    const row = await changeRow("feat-behind");
    expect(row).toBeTruthy();
    // Two-dot against the trunk TIP attributed the migration + big.ts (as
    // deletions) to this one-line Change: critical risk, services tier, and a
    // sensitive-path human-review requirement on files not in the diff.
    expect(row.changedPaths).toEqual(["README.md"]);
    expect(row.computedRisk).toBe("low");
    expect(row.riskReasons).toEqual([]);
    expect(row.verifyTier).toBe("static");
  });

  it("#175: a bare additive fixup push preserves declared intent/risk/focus/scope/description", async () => {
    const g = simpleGit(work);
    await g.raw(["checkout", "-B", "feat-fixup", "main"]);
    await writeFile(path.join(work, "src.ts"), "export const a = 1;\n// cache invalidation\n");
    const c1 = await commitAll([
      "Add the cache layer",
      "",
      "This adds a request cache to the profile API.",
      "",
      "Intent: Add a request cache to the profile API",
      "Risk: high",
      "Scope: src.ts",
      "Review-Focus: src.ts:1-2 invalidation logic",
    ].join("\n"));
    await pushBranch("feat-fixup");
    await run("feat-fixup", "0".repeat(40), c1);

    const before = await changeRow("feat-fixup");
    expect(before.intent).toBe("Add a request cache to the profile API");
    expect(before.risk).toBe("high");

    // The ordinary "address review feedback" push: additive, trailer-less.
    await writeFile(path.join(work, "src.ts"), "export const a = 1;\n// cache invalidation (typo fixed)\n");
    const c2 = await commitAll("fix typo");
    await pushBranch("feat-fixup");
    await run("feat-fixup", c1, c2);

    const after = await changeRow("feat-fixup");
    expect(after.headCommit).toBe(c2);
    // The whole branch still declares all of this — the row must too.
    expect(after.intent).toBe("Add a request cache to the profile API");
    expect(after.risk).toBe("high");
    expect(after.scope).toContain("src.ts");
    expect((after.reviewFocus as Array<{ raw?: string }>).length).toBeGreaterThan(0);
    expect(JSON.stringify(after.reviewFocus)).toContain("invalidation logic");
    expect(after.description ?? "").toContain("request cache");
    expect(Object.keys((after.trailers ?? {}) as Record<string, unknown>)).toContain("Intent");
    // A trailer-less push preserves the draft state (unchanged semantics).
    expect(after.isDraft).toBe(false);

    // Last declaration wins: a later commit that re-declares overrides.
    await writeFile(path.join(work, "src.ts"), "export const a = 2;\n");
    const c3 = await commitAll("Retitle\n\nIntent: Rework the cache layer\nRisk: medium");
    await pushBranch("feat-fixup");
    await run("feat-fixup", c2, c3);
    const retitled = await changeRow("feat-fixup");
    expect(retitled.intent).toBe("Rework the cache layer");
    expect(retitled.risk).toBe("medium");
  });

  it("#186: a direct default-branch push populates the trigram code index", async () => {
    const g = simpleGit(work);
    await g.raw(["checkout", "main"]);
    await writeFile(path.join(work, "indexed.ts"), "export function findDivergences() { return 42; }\n");
    const oldTip = (await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, "main"))).limit(1))[0].headCommit;
    const tip = await commitAll("add searchable symbol");
    await pushBranch("main");

    await run("main", oldTip, tip);
    // The indexer runs in the handler's detached best-effort block — poll.
    let rows: Array<{ path: string }> = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      rows = await db.select({ path: codeIndexShards.path }).from(codeIndexShards).where(eq(codeIndexShards.repoId, repoId));
      if (!rows.length) await new Promise(res => setTimeout(res, 100));
    }
    expect(rows.map(r => r.path)).toContain("indexed.ts");
  });

  it("#129: adopting a merge.yml overlays the named keys and keeps every unexpressible one", async () => {
    const hardened = {
      requireCiRun: true,
      blockAgentDirectDefaultPush: true,
      sensitiveBaseline: false,
      dismissStaleApprovals: false,
      minApprovalsHuman: 1,
      verifyTier: { minVerifyTier: "services" },
      verifiedAutonomy: { enabled: true, maxRisk: "medium", allowSensitivePaths: false },
      autoMergeOnVerified: true,
    };
    await db.update(repositories).set({ mergePolicy: hardened }).where(eq(repositories.id, repoId));

    const g = simpleGit(work);
    await g.raw(["checkout", "main"]);
    await mkdir(path.join(work, ".clawhub/policies"), { recursive: true });
    // Names exactly the governance.md example keys — none of the hardened ones.
    await writeFile(path.join(work, ".clawhub/policies/merge.yml"), [
      "minApprovalsHuman: 0",
      "requireHumanApprovalLevel: high",
      "allowSelfReview: true",
      "ciRequired: true",
    ].join("\n") + "\n");
    const oldTip = (await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, "main"))).limit(1))[0].headCommit;
    const tip = await commitAll("adopt policy file");
    await pushBranch("main");
    await run("main", oldTip, tip);

    const mp = (await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0]
      .mergePolicy as Record<string, unknown>;
    // Named keys took effect (the file still overrides the DB value).
    expect(mp.minApprovalsHuman).toBe(0);
    expect(mp.allowSelfReview).toBe(true);
    expect(mp.requireHumanApprovalLevel).toBe("high");
    // Everything the DSL cannot express survives — including the permissive-ward
    // four and the deliberate fail-safe opt-outs.
    expect(mp.requireCiRun).toBe(true);
    expect(mp.blockAgentDirectDefaultPush).toBe(true);
    expect(mp.verifyTier).toEqual({ minVerifyTier: "services" });
    expect(mp.verifiedAutonomy).toEqual({ enabled: true, maxRisk: "medium", allowSensitivePaths: false });
    expect(mp.autoMergeOnVerified).toBe(true);
    expect(mp.sensitiveBaseline).toBe(false);
    expect(mp.dismissStaleApprovals).toBe(false);
  });

  it("#129 follow-up: a direct default-branch push by an AGENT never mutates the stored policy", async () => {
    // The merge-path justification ("a policy change can only land through a
    // human" — .clawhub/policies/** is baseline-sensitive) does not cover a
    // DIRECT push: blockAgentDirectDefaultPush is opt-in, so under the default
    // posture any writer-granted agent can push straight to main. Adoption on
    // that path would make a push grant admin-equivalent policy mutation.
    // DEFAULT posture: blockAgentDirectDefaultPush is opt-in and off. The prior
    // test's hardened policy set it — drop it so the agent's push actually
    // reaches the adoption code (with it on, branch protection rejects first,
    // which is the opt-in defense, not the default one under test).
    const withBlock = (await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories)
      .where(eq(repositories.id, repoId)).limit(1))[0].mergePolicy as Record<string, unknown>;
    const { blockAgentDirectDefaultPush: _drop, ...defaultPosture } = withBlock;
    await db.update(repositories).set({ mergePolicy: defaultPosture }).where(eq(repositories.id, repoId));
    const beforeMp = defaultPosture;

    const [a] = await db.insert(agents).values({
      name: `pp-agent-${S}`, tokenHash: "x", gitAuthorName: "pp-bot", gitAuthorEmail: "pp-bot@clawhub.test",
    }).returning();
    const g = simpleGit(work);
    await g.raw(["checkout", "main"]);
    await writeFile(path.join(work, ".clawhub/policies/merge.yml"), [
      "minApprovalsHuman: 3",     // differs from the adopted values above, so a
      "allowSelfReview: false",   // wrongful adoption is observable
    ].join("\n") + "\n");
    const oldTip = (await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, "main"))).limit(1))[0].headCommit;
    const tip = await commitAll("agent pushes a policy file");
    await pushBranch("main");
    await processPush({
      db, git,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName, repoId, defaultBranch: "main",
      actor: { kind: "agent", agentId: a.id },
      pushedRefs: [{ ref: "refs/heads/main", oldSha: oldTip, newSha: tip }],
    });

    const afterMp = (await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories)
      .where(eq(repositories.id, repoId)).limit(1))[0].mergePolicy as Record<string, unknown>;
    // The file landed in git, but the stored policy is byte-identical.
    expect(afterMp).toEqual(beforeMp);
    expect(afterMp.minApprovalsHuman).toBe(0);
    expect(afterMp.allowSelfReview).toBe(true);
  });
});
