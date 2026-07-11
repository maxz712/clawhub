import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, branches, changes, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { EventBus } from "../src/services/events.js";
import { ChangeService } from "../src/services/changes.js";
import { GitError } from "../src/services/errors.js";

// Regression coverage for #61: rollback() used to swallow a failed revert-commit
// git operation and still mark the Change `rolled_back` — every signal (status,
// audit, memory) said the revert happened while the bad code stayed live on the
// default branch. This exercises rollback() against a REAL bare repo + a real
// Postgres row so a passing test actually proves the branch head moved.
const S = Date.now();

describe.skipIf(!hasTestDb)("ChangeService.rollback", () => {
  let git: GitService;
  let events: EventBus;
  let svc: ChangeService;
  let ns: string;
  let repoId: string;
  let repoName: string;
  let agentId: string;

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "clawhub-rollback-test-"));
    git = new GitService(base);
    events = new EventBus();
    svc = new ChangeService(db, git, events);

    const [u] = await db.insert(users).values({ email: `rb-${S}@t.co`, username: `rbu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    const [a] = await db.insert(agents).values({
      name: `rb-agent-${S}`, tokenHash: "x", gitAuthorName: "rb-bot", gitAuthorEmail: "rb-bot@clawhub.test",
    }).returning();
    agentId = a.id;

    repoName = `rbrepo${S}`;
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id, defaultBranch: "main" }).returning();
    repoId = r.id;
    await git.initBare(ns, repoName);
  });

  /** Seed main with a base commit, then a "merge" commit on top (simulating a merged Change). */
  async function seedMergedChange(): Promise<{ baseSha: string; mergeSha: string; changeId: string }> {
    const g = git.open(ns, repoName).env({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.co" });
    const emptyTree = (await g.raw(["hash-object", "-t", "tree", "/dev/null"])).trim();
    const baseSha = (await g.raw(["commit-tree", emptyTree, "-m", "base"])).trim();
    await g.raw(["update-ref", "refs/heads/main", baseSha]);
    // A second commit on top of base — stands in for the merged feature (same
    // empty tree is fine; rollback only cares about the commit graph here).
    const mergeSha = (await g.raw(["commit-tree", emptyTree, "-p", baseSha, "-m", "merge commit"])).trim();
    await g.raw(["update-ref", "refs/heads/main", mergeSha, baseSha]);

    const [chg] = await db.insert(changes).values({
      repoId, branch: `feature-${Date.now()}-${Math.random().toString(36).slice(2)}`, headCommit: mergeSha, intent: "test change",
      status: "merged", openedByAgentId: agentId, mergeCommit: mergeSha, mergedAt: new Date(),
    }).returning();
    await db.insert(branches).values({ repoId, name: "main", headCommit: mergeSha }).onConflictDoNothing();
    await db.update(branches).set({ headCommit: mergeSha }).where(eq(branches.repoId, repoId));
    return { baseSha, mergeSha, changeId: chg.id };
  }

  it("rolls back a merged change and actually moves the default branch head", async () => {
    const { baseSha, mergeSha, changeId } = await seedMergedChange();
    await svc.rollback(changeId, { kind: "agent", id: agentId });

    const newHead = await git.headCommit(ns, repoName, "main");
    expect(newHead).not.toBe(mergeSha); // the revert commit actually landed
    expect(newHead).toMatch(/^[0-9a-f]{40}$/);

    const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
    expect(row.status).toBe("rolled_back");

    // branches.headCommit must reflect the revert too, or event/schedule triggers
    // (and the dashboard) keep resolving the reverted code as current.
    const branchRow = (await db.select().from(branches).where(eq(branches.repoId, repoId)).limit(1))[0];
    expect(branchRow.headCommit).toBe(newHead);
    expect(branchRow.headCommit).not.toBe(mergeSha);
    void baseSha;
  });

  it("does NOT mark the change rolled_back when the revert git op fails", async () => {
    const { mergeSha, changeId } = await seedMergedChange();
    // Break the revert: mergeCommit has no first parent to revert against.
    await db.update(changes).set({ mergeCommit: "0".repeat(40) }).where(eq(changes.id, changeId));

    await expect(svc.rollback(changeId, { kind: "agent", id: agentId })).rejects.toThrow(GitError);

    const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
    expect(row.status).toBe("merged"); // NOT rolled_back — the bad code is still live

    const headAfter = await git.headCommit(ns, repoName, "main");
    expect(headAfter).toBe(mergeSha); // branch untouched
  });
});
