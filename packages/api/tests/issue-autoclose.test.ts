import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import simpleGit from "simple-git";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, issueChanges, issues, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { EventBus } from "../src/services/events.js";
import { ChangeService } from "../src/services/changes.js";
import { processPush } from "../src/services/post-push.js";

// #137 — `Closes: #N` used to be recorded as `issues.closing_change_id`, a
// SINGLE scalar that every push overwrote. All three legs of the contract
// (claim on push, close on merge, reopen on rollback) matched that one scalar,
// so a SECOND unmerged branch trailing the same number stole it: the first
// Change then merged with a WHERE matching zero rows and the issue silently
// stayed open — no error, no log, no UI difference. That is the steady state the
// Autonomous Loop manufactures on its own: the developer re-grabs the
// still-open assigned issue every cadence tick and re-ships finished work.
//
// The fix moves the source of truth to `issue_changes.closes` (the N:M table
// already written on this exact path) and demotes closing_change_id to
// provenance stamped by the merge that actually closed the issue.
//
// These drive the REAL processPush + the REAL ChangeService.merge/rollback over
// a REAL bare git repo against a REAL Postgres, because the whole defect is
// about WHICH row each side reads — a hand-built fixture of issue_changes rows
// would re-encode the assumption under test and pass with the fix reverted.

const S = Date.now();

describe.skipIf(!hasTestDb)("Closes: #N survives a second branch claiming the same issue (#137)", () => {
  let base: string;
  let work: string;
  let git: GitService;
  let svc: ChangeService;
  let ns: string, repoName: string, repoId: string, agentId: string;
  let issueSeq = 0;

  beforeAll(async () => {
    base = await mkdtemp(path.join(tmpdir(), "clawhub-autoclose-"));
    git = new GitService(path.join(base, "repos"));
    // `mergeInto` needs `git merge-tree --write-tree` (git >= 2.38). Prefer the
    // REAL plumbing — on a modern git these tests exercise merge() end to end —
    // but fall back to a two-parent commit-tree on an older git so the ISSUE
    // bookkeeping this suite is actually about stays covered everywhere rather
    // than silently skipping on whatever git the runner happens to ship.
    const realMergeInto = git.mergeInto.bind(git);
    git.mergeInto = async (namespace, repo, baseBranch, headCommit, an, ae, message) => {
      try {
        return await realMergeInto(namespace, repo, baseBranch, headCommit, an, ae, message);
      } catch (e) {
        if (!/unknown rev --write-tree|merge-tree/.test((e as Error).message)) throw e;
        const g = simpleGit(git.pathOf(namespace, repo)).env({
          GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_COMMITTER_NAME: an, GIT_COMMITTER_EMAIL: ae,
        });
        const baseSha = (await g.revparse([baseBranch])).trim();
        const tree = (await g.revparse([`${headCommit}^{tree}`])).trim();
        const commit = (await g.raw(["commit-tree", tree, "-p", baseSha, "-p", headCommit, "-m", message])).trim();
        await g.raw(["update-ref", `refs/heads/${baseBranch}`, commit, baseSha]);
        return commit;
      }
    };
    svc = new ChangeService(db, git, new EventBus());

    const [u] = await db.insert(users).values({ email: `ac-${S}@t.co`, username: `acu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    const [a] = await db.insert(agents).values({
      name: `ac-agent-${S}`, tokenHash: "x", gitAuthorName: "ac-bot", gitAuthorEmail: "ac-bot@clawhub.test",
    }).returning();
    agentId = a.id;
    repoName = `acrepo${S}`;
    // minApprovalsTotal 0 so merge() reaches the ISSUE bookkeeping under test
    // without this suite re-litigating the approval gate (merge-policy.test.ts).
    const [r] = await db.insert(repositories).values({
      name: repoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "main",
      mergePolicy: { minApprovalsTotal: 0, requireHumanApproval: "never", sensitiveBaseline: false },
    }).returning();
    repoId = r.id;
    await git.initBare(ns, repoName);

    work = path.join(base, "work");
    await mkdir(work, { recursive: true });
    const g = simpleGit(work);
    await g.init(["-b", "main"]);
    await g.addConfig("user.name", "t");
    await g.addConfig("user.email", "t@t");
    await writeFile(path.join(work, "README.md"), "# repo\n");
    await g.add(["-A"]);
    await g.commit("init");
    await g.raw(["push", "--force", git.pathOf(ns, repoName), "HEAD:refs/heads/main"]);
    await db.insert(branches).values({ repoId, name: "main", headCommit: (await g.revparse(["HEAD"])).trim() }).onConflictDoNothing();
  });

  afterAll(async () => { if (base) await rm(base, { recursive: true, force: true }); });

  const newIssue = async () => (await db.insert(issues).values({
    repoId, number: 5000 + S % 1000 * 100 + issueSeq++, title: "task the agent will ship", status: "open",
    createdByKind: "agent", createdById: agentId,
  }).returning())[0];

  /** Push a real branch trailing `Closes: #n` through the real post-push pipeline. */
  async function pushClosing(branch: string, n: number, file: string): Promise<string> {
    const g = simpleGit(work);
    await g.raw(["checkout", "-B", branch, "main"]);
    await writeFile(path.join(work, file), `// ${branch}\n`);
    await g.add(["-A"]);
    await g.commit([`Implement #${n} on ${branch}`, "", "Intent: implement the task", "Risk: low", `Closes: #${n}`].join("\n"));
    const newSha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", git.pathOf(ns, repoName), `HEAD:refs/heads/${branch}`]);
    await processPush({
      db, git,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName, repoId, defaultBranch: "main",
      actor: { kind: "agent", agentId },
      pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha }],
    });
    const row = (await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1))[0];
    expect(row, `push of ${branch} should have opened a Change`).toBeTruthy();
    return row.id;
  }

  const merge = (changeId: string) => svc.merge(changeId, { kind: "agent", id: agentId });
  const rollback = (changeId: string) => svc.rollback(changeId, { kind: "agent", id: agentId });
  const readIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)).limit(1))[0];
  const linksFor = (issueId: string) => db.select().from(issueChanges).where(eq(issueChanges.issueId, issueId));

  it("a push RECORDS the claim as a closing link and does NOT touch the issue row", async () => {
    const issue = await newIssue();
    const a = await pushClosing(`d${issue.number}a`, issue.number, `a${issue.number}.ts`);

    const after = await readIssue(issue.id);
    // The old code stamped closingChangeId right here — a speculative claim by a
    // Change that may never merge, and the scalar the next push would steal.
    expect(after.closingChangeId).toBeNull();
    expect(after.status).toBe("open");

    const links = await linksFor(issue.id);
    expect(links).toHaveLength(1);
    expect(links[0].changeId).toBe(a);
    expect(links[0].closes).toBe(true); // a trailer claim, not a manual link
  });

  it("merging the FIRST of two branches that both claim the issue still closes it", async () => {
    const issue = await newIssue();
    const a = await pushClosing(`d${issue.number}a`, issue.number, `a${issue.number}.ts`);
    // The clobber: a second, still-unmerged branch claiming the same number —
    // what a daily-cadence developer agent produces on its own while the human
    // hasn't reviewed A yet and the queue still reports the issue open.
    const b = await pushClosing(`d${issue.number}b`, issue.number, `b${issue.number}.ts`);
    expect(a).not.toBe(b);
    expect((await linksFor(issue.id)).map(l => l.changeId).sort()).toEqual([a, b].sort());

    await merge(a);

    const after = await readIssue(issue.id);
    expect(after.status).toBe("closed");
    expect(after.closingChangeId).toBe(a); // provenance = the change that ACTUALLY closed it
  });

  it("merging the SECOND claimant afterwards is a no-op and never rewrites the provenance", async () => {
    const issue = await newIssue();
    const a = await pushClosing(`d${issue.number}a`, issue.number, `a${issue.number}.ts`);
    const b = await pushClosing(`d${issue.number}b`, issue.number, `b${issue.number}.ts`);

    await merge(a);
    await merge(b);

    const after = await readIssue(issue.id);
    expect(after.status).toBe("closed");
    expect(after.closingChangeId).toBe(a); // NOT b — the first merge is what closed it
  });

  it("pushing a NEW claim at an already-closed issue leaves the pointer alone but still links", async () => {
    const issue = await newIssue();
    const a = await pushClosing(`d${issue.number}a`, issue.number, `a${issue.number}.ts`);
    await merge(a);
    expect((await readIssue(issue.id)).status).toBe("closed");

    // A follow-up / cherry-pick carrying the same trailer. The old UPDATE had no
    // status filter, so this re-pointed a CLOSED issue at an unmerged branch and
    // broke rollback for the merge that had actually closed it.
    const b = await pushClosing(`d${issue.number}b`, issue.number, `b${issue.number}.ts`);

    const after = await readIssue(issue.id);
    expect(after.status).toBe("closed");
    expect(after.closingChangeId).toBe(a);
    expect((await linksFor(issue.id)).map(l => l.changeId).sort()).toEqual([a, b].sort());
  });

  it("rolling back the merged change reopens the issue even after a second branch claimed it", async () => {
    const issue = await newIssue();
    const a = await pushClosing(`d${issue.number}a`, issue.number, `a${issue.number}.ts`);
    await merge(a);
    const b = await pushClosing(`d${issue.number}b`, issue.number, `b${issue.number}.ts`);
    expect((await readIssue(issue.id)).status).toBe("closed");

    await rollback(a);

    const after = await readIssue(issue.id);
    expect(after.status).toBe("open"); // the closing work is no longer on the default branch
    expect(after.closingChangeId).toBe(a); // provenance kept ("closed by a, later rolled back")
    // B is untouched and still linked, so merging it later still closes the issue.
    const bLink = (await linksFor(issue.id)).find(l => l.changeId === b);
    expect(bLink?.closes).toBe(true);
    expect((await db.select().from(changes).where(eq(changes.id, b)).limit(1))[0].status).not.toBe("merged");
  });

  it("a MANUAL link does not auto-close on merge — only a Closes: trailer does (#137 decision)", async () => {
    const issue = await newIssue();
    // A change with no Closes: trailer, linked to the issue the way the UI's
    // "Link a change" affordance / POST .../issues/:num/changes does.
    const g = simpleGit(work);
    const branch = `d${issue.number}m`;
    await g.raw(["checkout", "-B", branch, "main"]);
    await writeFile(path.join(work, `m${issue.number}.ts`), "// related work\n");
    await g.add(["-A"]);
    await g.commit(["Related work", "", "Intent: related work", "Risk: low"].join("\n"));
    const newSha = (await g.revparse(["HEAD"])).trim();
    await g.raw(["push", "--force", git.pathOf(ns, repoName), `HEAD:refs/heads/${branch}`]);
    await processPush({
      db, git,
      changeRefs: { set: async () => {} } as never,
      events: { publish: async () => {} } as never,
      namespace: ns, repoName, repoId, defaultBranch: "main",
      actor: { kind: "agent", agentId },
      pushedRefs: [{ ref: `refs/heads/${branch}`, oldSha: "0".repeat(40), newSha }],
    });
    const changeId = (await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1))[0].id;
    await db.insert(issueChanges).values({ issueId: issue.id, changeId, repoId }).onConflictDoNothing();

    await merge(changeId);

    const after = await readIssue(issue.id);
    expect(after.status).toBe("open"); // linking is association, not a claim to close
    expect(after.closingChangeId).toBeNull();
  });
});
