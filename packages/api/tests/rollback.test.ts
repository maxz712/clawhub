import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import Redis from "ioredis";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { accessRoles, agents, branches, changes, issues, publicActivity, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { GitService } from "../src/services/git.js";
import { EventBus } from "../src/services/events.js";
import { ChangeService } from "../src/services/changes.js";
import { GitError } from "../src/services/errors.js";
import { createChangeRoutes } from "../src/routes/changes.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";

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
  let redis: Redis | null = null;
  let hasRedis = false;

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

    try {
      redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true, connectTimeout: 1_500, maxRetriesPerRequest: 1 });
      await redis.connect();
      await redis.ping();
      hasRedis = true;
    } catch { hasRedis = false; }
  });

  afterAll(async () => {
    if (redis) await redis.quit().catch(() => {});
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

  // Regression coverage for #62: rollback()'s git-mutating body used to run with
  // NO repo lock, unlike merge()/updateBranch() which both serialize their
  // ref + branches.headCommit writes via withRepoLock({kind:"merge"}). A rollback
  // starting while a merge() (or another rollback()) is mid-flight on the same
  // repo must wait for that same lock — not barge in and interleave ref/DB
  // writes with the concurrent operation. We simulate "mid-flight" the same way
  // any real caller of withRepoLock would show up on Redis: hold the exact lock
  // key rollback() now takes, and assert rollback() blocks until it's released.
  it("waits for the repo lock instead of racing a concurrent merge()/rollback() on the same repo", async () => {
    const { mergeSha, changeId } = await seedMergedChange();
    if (!hasRedis) return; // no Redis reachable in this environment — skip, don't false-fail.

    const lockKey = `clawhub:repolock:merge:${repoId}`;
    const held = await redis!.set(lockKey, "held-by-test", "PX", 5_000, "NX");
    expect(held).toBe("OK"); // sanity: we actually own the lock before starting rollback

    const rollbackPromise = svc.rollback(changeId, { kind: "agent", id: agentId });
    let settled = false;
    rollbackPromise.then(() => { settled = true; }, () => { settled = true; });

    // Give rollback() ample time to reach the lock and (with the fix) block on it.
    await new Promise(res => setTimeout(res, 300));
    expect(settled).toBe(false); // still waiting on the held lock — did NOT barge in

    await redis!.del(lockKey);
    await rollbackPromise; // now proceeds and completes once the lock frees up

    const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
    expect(row.status).toBe("rolled_back");
    const newHead = await git.headCommit(ns, repoName, "main");
    expect(newHead).not.toBe(mergeSha);
  });

  // Regression coverage for #66: rollback() used to leave issues closed by the
  // rolled-back Change's Closes: trailer closed forever, even though the code
  // that closed them no longer exists on the default branch. merge() closes via
  // `where(repoId, closingChangeId)` (changes.ts ~L516) — rollback() must mirror
  // that exactly, but flipping status back to open.
  describe("reopens issues the rolled-back change had auto-closed", () => {
    let issueNum = 900;

    it("reopens an issue whose closingChangeId points at the rolled-back change", async () => {
      const { changeId } = await seedMergedChange();
      const [issue] = await db.insert(issues).values({
        repoId, number: issueNum++, title: "closed by the change under test",
        status: "closed", closingChangeId: changeId, createdByKind: "agent", createdById: agentId,
      }).returning();

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const row = (await db.select().from(issues).where(eq(issues.id, issue.id)).limit(1))[0];
      expect(row.status).toBe("open");
      expect(row.closingChangeId).toBe(changeId); // provenance kept, not cleared
    });

    // Regression coverage for #102: the #42 daily sweep moves stale closed
    // issues to 'archived' — a closed-family state. Rolling back an OLD merge
    // (exactly the case where its issues have aged into the archive) must
    // still reopen them; the status filter exists only to skip issues a human
    // already reopened, not to skip the archive.
    it("reopens an issue the auto-archive sweep moved to 'archived'", async () => {
      const { changeId } = await seedMergedChange();
      const [issue] = await db.insert(issues).values({
        repoId, number: issueNum++, title: "archived by the daily sweep",
        status: "archived", closingChangeId: changeId, createdByKind: "agent", createdById: agentId,
      }).returning();

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const row = (await db.select().from(issues).where(eq(issues.id, issue.id)).limit(1))[0];
      expect(row.status).toBe("open");
      expect(row.closingChangeId).toBe(changeId); // provenance kept, not cleared
    });

    it("leaves an issue closed by a DIFFERENT change untouched", async () => {
      const { changeId } = await seedMergedChange();
      const { changeId: otherChangeId } = await seedMergedChange();
      const [unrelated] = await db.insert(issues).values({
        repoId, number: issueNum++, title: "closed by a different change",
        status: "closed", closingChangeId: otherChangeId, createdByKind: "agent", createdById: agentId,
      }).returning();

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const row = (await db.select().from(issues).where(eq(issues.id, unrelated.id)).limit(1))[0];
      expect(row.status).toBe("closed"); // untouched — not linked to the rolled-back change
    });

    it("does not double-process an issue already reopened before the rollback", async () => {
      const { changeId } = await seedMergedChange();
      const [issue] = await db.insert(issues).values({
        repoId, number: issueNum++, title: "manually reopened already",
        status: "open", closingChangeId: changeId, createdByKind: "agent", createdById: agentId,
      }).returning();
      const beforeUpdatedAt = issue.updatedAt;

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const row = (await db.select().from(issues).where(eq(issues.id, issue.id)).limit(1))[0];
      expect(row.status).toBe("open");
      // untouched by rollback's UPDATE (which is scoped to status in closed/archived) — updatedAt unchanged
      expect(row.updatedAt.getTime()).toBe(beforeUpdatedAt.getTime());
    });
  });

  // Regression coverage for #71: rollback() used to insert NO publicActivity row
  // at all, unlike merge() (which inserts a "change.merged" row on a public repo)
  // — the platform's most notable negative event was invisible on /trending, the
  // RSS feed, the changelog, and the author's identity activity history.
  describe("public activity", () => {
    let publicRepoId: string;
    let publicRepoName: string;

    beforeAll(async () => {
      publicRepoName = `rbpubrepo${S}`;
      const [r] = await db.insert(repositories).values({
        name: publicRepoName, namespaceType: "user", namespaceId: (await db.select().from(users).where(eq(users.username, ns)).limit(1))[0].id,
        defaultBranch: "main", isPublic: true,
      }).returning();
      publicRepoId = r.id;
      await git.initBare(ns, publicRepoName);
    });

    /** Same as seedMergedChange, but against the dedicated public repo. */
    async function seedMergedChangeOnPublicRepo(): Promise<{ mergeSha: string; changeId: string }> {
      const g = git.open(ns, publicRepoName).env({ GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.co", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.co" });
      const emptyTree = (await g.raw(["hash-object", "-t", "tree", "/dev/null"])).trim();
      const baseSha = (await g.raw(["commit-tree", emptyTree, "-m", "base"])).trim();
      await g.raw(["update-ref", "refs/heads/main", baseSha]);
      const mergeSha = (await g.raw(["commit-tree", emptyTree, "-p", baseSha, "-m", "merge commit"])).trim();
      await g.raw(["update-ref", "refs/heads/main", mergeSha, baseSha]);

      const [chg] = await db.insert(changes).values({
        repoId: publicRepoId, branch: `feature-${Date.now()}-${Math.random().toString(36).slice(2)}`, headCommit: mergeSha, intent: "public test change",
        status: "merged", openedByAgentId: agentId, mergeCommit: mergeSha, mergedAt: new Date(),
      }).returning();
      await db.insert(branches).values({ repoId: publicRepoId, name: "main", headCommit: mergeSha }).onConflictDoNothing();
      await db.update(branches).set({ headCommit: mergeSha }).where(eq(branches.repoId, publicRepoId));
      return { mergeSha, changeId: chg.id };
    }

    it("inserts a change.rolled_back publicActivity row on a public repo, mirroring merge()'s change.merged row", async () => {
      const { changeId } = await seedMergedChangeOnPublicRepo();

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const rows = await db.select().from(publicActivity).where(eq(publicActivity.changeId, changeId));
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe("change.rolled_back");
      expect(rows[0].repoId).toBe(publicRepoId);
      expect(rows[0].agentId).toBe(agentId); // attributed to the change's ORIGINAL author, not the rollback actor
      expect(rows[0].summary).toBe("public test change");
    });

    it("does NOT insert a publicActivity row when the repo is private", async () => {
      const { changeId } = await seedMergedChange(); // the shared repo from the outer describe, isPublic:false by default

      await svc.rollback(changeId, { kind: "agent", id: agentId });

      const rows = await db.select().from(publicActivity).where(eq(publicActivity.changeId, changeId));
      expect(rows).toHaveLength(0);
    });
  });

  // Regression coverage for #67: POST .../rollback used to accept any caller with
  // plain repo write access — it never called requireMergeRights the way /merge
  // does. Exercise this at the HTTP route level (not just ChangeService.rollback
  // directly) since the missing check lived in the route handler.
  describe("POST /:ns/:repo/changes/:id/rollback enforces requireMergeRights like /merge does", () => {
    let ownerUserId: string;

    beforeAll(async () => {
      ownerUserId = (await db.select().from(users).where(eq(users.username, ns)).limit(1))[0].id;
    });

    function buildApp(): Hono {
      const changeSvc = new ChangeService(db, git, events);
      const app = new Hono();
      app.route("/api/v1/repos", createChangeRoutes(db, git, changeSvc));
      app.onError(errorHandler);
      return app;
    }

    /** A collaborator agent with plain write access (`role: "writer"`), optionally capped by an access role. */
    async function mkWriterAgent(permissions?: string[]) {
      const uniq = Math.random().toString(36).slice(2, 10);
      let accessRoleId: string | null = null;
      if (permissions) {
        const [role] = await db.insert(accessRoles).values({
          ownerUserId, name: `role-${uniq}`, permissions, repoScope: "all", repoIds: [],
        }).returning();
        accessRoleId = role.id;
      }
      const [a] = await db.insert(agents).values({
        name: `rb-http-agent-${uniq}`, tokenHash: "x", gitAuthorName: "rb-bot", gitAuthorEmail: "rb-bot2@clawhub.test",
        accessRoleId,
      }).returning();
      await db.insert(repoCollaborators).values({ repoId, agentId: a.id, role: "writer" });
      return a.id;
    }

    it("403s an agent whose role has repo:write + change:write but NOT change:merge", async () => {
      const { changeId } = await seedMergedChange();
      const roleAgentId = await mkWriterAgent(["repo:read", "repo:write", "change:write"]);
      const token = signToken({ kind: "agent", agentId: roleAgentId, name: "rb-role-agent" });

      const res = await buildApp().request(`/api/v1/repos/${ns}/${repoName}/changes/${changeId}/rollback`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(403);

      const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
      expect(row.status).toBe("merged"); // untouched — rollback never ran
    });

    it("still allows rollback for an agent whose role holds change:merge", async () => {
      const { changeId, mergeSha } = await seedMergedChange();
      const roleAgentId = await mkWriterAgent(["repo:read", "repo:write", "change:merge"]);
      const token = signToken({ kind: "agent", agentId: roleAgentId, name: "rb-role-agent" });

      const res = await buildApp().request(`/api/v1/repos/${ns}/${repoName}/changes/${changeId}/rollback`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
      expect(row.status).toBe("rolled_back");
      const newHead = await git.headCommit(ns, repoName, "main");
      expect(newHead).not.toBe(mergeSha);
    });

    it("still allows rollback for a role-less agent (legacy: write access admits merge)", async () => {
      const { changeId, mergeSha } = await seedMergedChange();
      const legacyAgentId = await mkWriterAgent();
      const token = signToken({ kind: "agent", agentId: legacyAgentId, name: "rb-legacy-agent" });

      const res = await buildApp().request(`/api/v1/repos/${ns}/${repoName}/changes/${changeId}/rollback`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);

      const row = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
      expect(row.status).toBe("rolled_back");
      const newHead = await git.headCommit(ns, repoName, "main");
      expect(newHead).not.toBe(mergeSha);
    });
  });
});
