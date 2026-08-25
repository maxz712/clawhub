import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, ciPipelines, ciRuns, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { EventBus } from "../src/services/events.js";
import { ChangeService } from "../src/services/changes.js";
import { ConflictError } from "../src/services/errors.js";
import { processPush } from "../src/services/post-push.js";

// Two merge-gate integrity holes, driven end to end over a real bare repo + a
// real Postgres, because both defects live in the WIRING (what the gate reads),
// not in any pure function:
//
// #147 — the only conflict gate on the merge path was the push-time
// `hasConflicts` flag. A Change that was clean when pushed but conflicts with
// the CURRENT base (another Change touched the same lines and merged first)
// sailed past it, and the git layer committed the CONFLICTED tree to the
// default branch as a "successful" merge.
//
// #203 — cancelling a change's CI run (abandon) stamps the run
// `skipped`+terminalReason, which the head-run vote folded into `success`:
// abandon → reopen → merge landed under `ciRequired`+`requireCiRun` with zero
// CI steps ever executed.

const S = Date.now();

describe.skipIf(!hasTestDb)("merge-gate integrity (#147 / #203)", () => {
  let base: string;
  let work: string;
  let git: GitService;
  let svc: ChangeService;
  let ns: string;
  let seq = 0;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-mgi-"));
    git = new GitService(path.join(base, "repos"));
    svc = new ChangeService(db, git, new EventBus());
    const [u] = await db.insert(users).values({ email: `mgi-${S}@t.co`, username: `mgiu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  async function makeRepo(mergePolicy: Record<string, unknown>): Promise<{ repoId: string; repoName: string; agentId: string; workdir: string }> {
    const n = seq++;
    const repoName = `mgirepo${S}x${n}`;
    const uid = (await db.select().from(users).where(eq(users.username, ns)).limit(1))[0].id;
    const [r] = await db.insert(repositories).values({
      name: repoName, namespaceType: "user", namespaceId: uid, defaultBranch: "main", mergePolicy,
    }).returning();
    const [a] = await db.insert(agents).values({
      name: `mgi-agent-${S}-${n}`, tokenHash: "x", gitAuthorName: "mgi-bot", gitAuthorEmail: "mgi-bot@clawhub.test",
    }).returning();
    await git.initBare(ns, repoName);
    const workdir = path.join(base, `work${n}`);
    await mkdir(workdir, { recursive: true });
    const g = simpleGit(workdir);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(workdir, "f.txt"), "base line\n");
    await g.add(["-A"]);
    await g.commit("init");
    await g.raw(["push", "--force", git.pathOf(ns, repoName), "HEAD:refs/heads/main"]);
    await db.insert(branches).values({ repoId: r.id, name: "main", headCommit: (await g.revparse(["HEAD"])).trim() });
    return { repoId: r.id, repoName, agentId: a.id, workdir };
  }

  /** Push a real branch through the real post-push pipeline; returns the Change id. */
  async function pushBranch(ctx: { repoId: string; repoName: string; agentId: string; workdir: string }, branch: string, file: string, content: string): Promise<string> {
    const g = simpleGit(ctx.workdir);
    await g.raw(["checkout", "-B", branch, "main"]);
    await writeFile(path.join(ctx.workdir, file), content);
    await g.add(["-A"]);
    await g.commit([`Work on ${branch}`, "", "Intent: do the work", "Risk: low"].join("\n"));
    const newSha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", git.pathOf(ns, ctx.repoName), `HEAD:refs/heads/${branch}`]);
    await processPush({
      db, git,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName: ctx.repoName, repoId: ctx.repoId, defaultBranch: "main",
      actor: { kind: "agent", agentId: ctx.agentId },
      pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha }],
    });
    const row = (await db.select().from(changes).where(and(eq(changes.repoId, ctx.repoId), eq(changes.branch, branch))).limit(1))[0];
    expect(row, `push of ${branch} should have opened a Change`).toBeTruthy();
    return row.id;
  }

  const readChange = async (id: string) => (await db.select().from(changes).where(eq(changes.id, id)).limit(1))[0];

  it("#147: a Change clean at push time but conflicting with the CURRENT base 409s, stays pending, and trunk is untouched", async () => {
    const ctx = await makeRepo({ minApprovalsTotal: 0, requireHumanApproval: "never", sensitiveBaseline: false, ciRequired: false });
    // A and B edit the same line of the same file. Both are clean vs main at push.
    const a = await pushBranch(ctx, "edit-a", "f.txt", "edited by A\n");
    const b = await pushBranch(ctx, "edit-b", "f.txt", "edited by B\n");
    expect((await readChange(a)).hasConflicts).toBe(false);

    await svc.merge(b, { kind: "agent", id: ctx.agentId });
    const mainAfterB = await git.headCommit(ns, ctx.repoName, "main");

    // A's stored hasConflicts is still false (push-time state) — the fresh
    // under-lock trialMerge is the only thing standing between this merge and a
    // conflict-markered trunk.
    expect((await readChange(a)).hasConflicts).toBe(false);
    await expect(svc.merge(a, { kind: "agent", id: ctx.agentId })).rejects.toThrow(ConflictError);

    expect((await readChange(a)).status).toBe("pending");
    expect(await git.headCommit(ns, ctx.repoName, "main")).toBe(mainAfterB);
    // The property that matters: no commit anywhere carries conflict markers.
    const revs = (await git.open(ns, ctx.repoName).raw(["rev-list", "--all"])).trim().split("\n").filter(Boolean);
    const grep = await git.open(ns, ctx.repoName).raw(["grep", "-l", "<<<<<<<", ...revs]).catch(() => "");
    expect(grep.trim()).toBe("");
  });

  it("#203: abandon → reopen does not launder a cancelled run into ciStatus success under requireCiRun", async () => {
    const ctx = await makeRepo({ minApprovalsTotal: 0, requireHumanApproval: "never", sensitiveBaseline: false, ciRequired: true, requireCiRun: true });
    await db.insert(ciPipelines).values({ repoId: ctx.repoId, name: "push-ci", yaml: "on: push\nsteps:\n  - run: echo ok\n", triggerKind: "push", enabled: true });

    const c = await pushBranch(ctx, "feat-ci", "g.txt", "feature\n");
    expect((await readChange(c)).ciStatus).toBe("pending");
    const runsBefore = await db.select().from(ciRuns).where(eq(ciRuns.changeId, c));
    expect(runsBefore).toHaveLength(1);

    await svc.abandon(c, { kind: "agent", id: ctx.agentId });
    // The cancelled run is skipped+reason; the immediate re-vote must NOT write success.
    const cancelled = (await db.select().from(ciRuns).where(eq(ciRuns.id, runsBefore[0].id)))[0];
    expect(cancelled.status).toBe("skipped");
    expect(cancelled.terminalReason).toBe("canceled");
    expect((await readChange(c)).ciStatus).not.toBe("success");

    await svc.reopen(c, { kind: "agent", id: ctx.agentId });
    // reopen re-queues the on:push pipeline at the current head so a real run can clear the gate.
    const runsAfter = await db.select().from(ciRuns).where(eq(ciRuns.changeId, c));
    expect(runsAfter.filter(r => r.status === "pending")).toHaveLength(1);
    expect((await readChange(c)).ciStatus).toBe("pending");

    const decision = await svc.evaluate(c);
    expect(decision.mergeable).toBe(false);
    await expect(svc.merge(c, { kind: "agent", id: ctx.agentId })).rejects.toMatchObject({ code: "merge_blocked" });

    // A real terminal report on the re-queued run clears the gate.
    const rerun = runsAfter.find(r => r.status === "pending")!;
    await db.update(ciRuns).set({ status: "success", finishedAt: new Date() }).where(eq(ciRuns.id, rerun.id));
    const after = await svc.evaluate(c);
    expect(after.mergeable).toBe(true);
  });
});
