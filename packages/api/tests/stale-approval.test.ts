import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { branches, changes, repositories, reviews, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { EventBus } from "../src/services/events.js";
import { createReviewRoutes } from "../src/routes/reviews.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ChangeService } from "../src/services/changes.js";
import { dismissStaleApprovals } from "../src/services/stale-approvals.js";
import { isStaleApproval, normalizeMergePolicy } from "../src/services/merge-policy.js";
import type { GitService } from "../src/services/git.js";

// #121 — an approval is pinned to the commit it was submitted against, and a
// push that moves the head dismisses it. Before this, `reviews` carried no head
// pin at all: approve commit A, push commit B, and the merge gate still counted
// the approval — the sensitive-path / high-risk human code-review requirement
// was satisfiable by approving one benign diff and then pushing anything.

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);

describe("isStaleApproval (pure)", () => {
  const at = (headCommit: string | null, over: Record<string, unknown> = {}) =>
    ({ verdict: "approve", advisory: false, headCommit, ...over });

  it("an approval naming a DIFFERENT commit than the head is stale", () => {
    expect(isStaleApproval(at(COMMIT_A), COMMIT_B)).toBe(true);
  });

  it("an approval naming the CURRENT head is not stale", () => {
    expect(isStaleApproval(at(COMMIT_A), COMMIT_A)).toBe(false);
  });

  it("a NULL pin is not stale on READ — legacy rows keep counting until the next push dismisses them", () => {
    // Deliberate: the fail-closed treatment of a null pin lives in the push path
    // (dismissStaleApprovals sweeps it), not here — so shipping the column does
    // not retroactively invalidate every in-flight approval on the instance.
    expect(isStaleApproval(at(null), COMMIT_B)).toBe(false);
  });

  it("request_changes and comment are never 'stale' — only approvals are dismissed", () => {
    expect(isStaleApproval(at(COMMIT_A, { verdict: "request_changes" }), COMMIT_B)).toBe(false);
    expect(isStaleApproval(at(COMMIT_A, { verdict: "comment" }), COMMIT_B)).toBe(false);
  });

  it("advisory (machine) reviews are out of scope — they never satisfy a gate slot", () => {
    expect(isStaleApproval(at(COMMIT_A, { advisory: true }), COMMIT_B)).toBe(false);
  });
});

describe("normalizeMergePolicy.dismissStaleApprovals", () => {
  it("defaults ON — a repo with no policy at all still dismisses stale approvals", () => {
    expect(normalizeMergePolicy({}).dismissStaleApprovals).toBe(true);
    expect(normalizeMergePolicy(undefined).dismissStaleApprovals).toBe(true);
    expect(normalizeMergePolicy({ dismissStaleApprovals: "no" }).dismissStaleApprovals).toBe(true);
  });

  it("an explicit false is the opt-out", () => {
    expect(normalizeMergePolicy({ dismissStaleApprovals: false }).dismissStaleApprovals).toBe(false);
  });
});

const S = Date.now();
let app: Hono, svc: ChangeService;
let ns: string, repoName: string, repoId: string;
let reviewerToken: string, authorId: string;

describe.skipIf(!hasTestDb)("stale approvals are dismissed on a new head", () => {
  beforeAll(async () => {
    // The repo OWNER is the reviewer (so they hold review rights); the Change is
    // authored by a different human, so no self-review lift is in play.
    const [reviewer] = await db.insert(users).values({ email: `sa-rev-${S}@t.co`, username: `sarev${S}`, passwordHash: "x" }).returning();
    const [author] = await db.insert(users).values({ email: `sa-aut-${S}@t.co`, username: `saaut${S}`, passwordHash: "x" }).returning();
    authorId = author.id;
    ns = reviewer.username!;
    reviewerToken = signToken({ kind: "user", userId: reviewer.id, email: reviewer.email });
    repoName = `sarepo${S}`;
    const [r] = await db.insert(repositories).values({
      name: repoName, namespaceType: "user", namespaceId: reviewer.id, mergePolicy: {},
    }).returning();
    repoId = r.id;
    app = new Hono();
    app.route("/api/v1/repos", createReviewRoutes(db, new EventBus()));
    app.onError(errorHandler);
    svc = new ChangeService(db, {} as GitService, new EventBus());
  });

  let n = 0;
  /** A fresh pending Change at COMMIT_A, medium risk (so ONE human approval is what unblocks it). */
  const newChange = async () => {
    const [c] = await db.insert(changes).values({
      repoId, branch: `feat-${S}-${n++}`, headCommit: COMMIT_A, intent: "t",
      risk: "medium", computedRisk: "medium", ciStatus: "skipped", status: "pending",
      openedByUserId: authorId, changedPaths: ["src/app.ts"], scope: ["src/app.ts"],
    }).returning();
    return c.id;
  };
  const review = (changeId: string, body: Record<string, unknown>) => app.request(
    `/api/v1/repos/${ns}/${repoName}/changes/${changeId}/reviews`,
    { method: "POST", headers: { authorization: `Bearer ${reviewerToken}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  /** What post-push.ts does inside its lock: move the head, dismiss mismatched approvals. */
  const push = async (changeId: string, newHead: string) => {
    await db.update(changes).set({ headCommit: newHead, status: "pending" }).where(eq(changes.id, changeId));
    return dismissStaleApprovals(db, changeId, newHead);
  };
  const liveApprovals = (changeId: string) => db.select().from(reviews).where(and(
    eq(reviews.changeId, changeId), isNull(reviews.supersededAt), eq(reviews.verdict, "approve"),
  ));

  it("stamps the head commit the verdict was formed against", async () => {
    const id = await newChange();
    const res = await review(id, { verdict: "approve", basis: "code" });
    expect(res.status).toBe(201);
    expect((await res.json()).review.headCommit).toBe(COMMIT_A);
  });

  it("THE BUG: approve at A → push B → the gate no longer counts it; re-approving at B unblocks", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    expect((await svc.evaluate(id)).mergeable).toBe(true);

    expect(await push(id, COMMIT_B)).toBe(1);
    const after = await svc.evaluate(id);
    expect(after.mergeable).toBe(false);
    expect(after.reason).toBe("needs_human_approval");
    expect(await liveApprovals(id)).toHaveLength(0);

    // A re-approval of the NEW diff is a real judgement, not a duplicate submit.
    const re = await review(id, { verdict: "approve", basis: "code" });
    expect(re.status).toBe(201);
    expect((await re.json()).review.headCommit).toBe(COMMIT_B);
    expect((await svc.evaluate(id)).mergeable).toBe(true);
  });

  it("the merge itself is refused, not just evaluate()", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    await push(id, COMMIT_B);
    await expect(svc.merge(id, { kind: "human", id: authorId })).rejects.toThrow(/merge blocked: needs_human_approval/);
  });

  it("REGRESSION GUARD: request_changes at A still blocks after a push to B", async () => {
    const id = await newChange();
    const res = await review(id, { verdict: "request_changes", summary: "no" });
    expect(res.status).toBe(201);
    await push(id, COMMIT_B);
    const rows = await db.select().from(reviews).where(and(eq(reviews.changeId, id), eq(reviews.verdict, "request_changes")));
    expect(rows[0].supersededAt).toBeNull(); // the NEGATIVE signal survives a push
    expect((await svc.evaluate(id)).reason).toBe("changes_requested");
  });

  it("comments survive a push untouched", async () => {
    const id = await newChange();
    await review(id, { verdict: "comment", summary: "fyi" });
    await push(id, COMMIT_B);
    const rows = await db.select().from(reviews).where(and(eq(reviews.changeId, id), eq(reviews.verdict, "comment")));
    expect(rows[0].supersededAt).toBeNull();
  });

  it("a LEGACY approval with no pin is dismissed on the first push (fail closed)", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    // Simulate a row written before the head_commit column existed.
    await db.update(reviews).set({ headCommit: null }).where(eq(reviews.changeId, id));
    expect((await svc.evaluate(id)).mergeable).toBe(true); // still counts before any push
    expect(await push(id, COMMIT_B)).toBe(1);
    expect((await svc.evaluate(id)).mergeable).toBe(false);
  });

  it("re-pushing the SAME sha is not a new diff — nothing is dismissed", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    // post-push only calls the sweep when headCommit actually moved; the sweep
    // itself is also a no-op for an approval already pinned to that sha.
    expect(await dismissStaleApprovals(db, id, COMMIT_A)).toBe(0);
    expect((await svc.evaluate(id)).mergeable).toBe(true);
  });

  it("READ-SIDE BACKSTOP: a mispinned approval that escaped dismissal still cannot satisfy the gate", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    // Move the head WITHOUT sweeping — the failure mode where a supersede is missed.
    await db.update(changes).set({ headCommit: COMMIT_C }).where(eq(changes.id, id));
    expect(await liveApprovals(id)).toHaveLength(1); // the row is still live...
    expect((await svc.evaluate(id)).mergeable).toBe(false); // ...but the gate rejects it
  });

  it("branch-protection approverCount uses the same non-stale set as the gate", async () => {
    // Isolate the protection counter from the policy gate: with human approval
    // turned off in policy, `requiredApprovals: 1` is the ONLY thing standing
    // between this change and a merge — so what it counts is directly visible.
    await db.insert(branches).values({ repoId, name: "main", headCommit: COMMIT_A, protection: { requiredApprovals: 1 } })
      .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { protection: { requiredApprovals: 1 } } });
    await db.update(repositories).set({ mergePolicy: { requireHumanApproval: "never", minApprovalsTotal: 0 } }).where(eq(repositories.id, repoId));
    try {
      const id = await newChange();
      await review(id, { verdict: "approve", basis: "code" });
      await push(id, COMMIT_B);
      // The stale approval must not be counted here either, or branch protection
      // would admit a merge the merge policy just refused (and vice versa).
      await expect(svc.merge(id, { kind: "human", id: authorId }))
        .rejects.toThrow("branch protection requires 1 approving review (got 0)");

      // Differential: re-approving the NEW head satisfies the counter, so the
      // failure moves past branch protection (to the stubbed git layer).
      await review(id, { verdict: "approve", basis: "code" });
      await expect(svc.merge(id, { kind: "human", id: authorId }))
        .rejects.not.toThrow("branch protection requires 1 approving review (got 0)");
    } finally {
      await db.update(repositories).set({ mergePolicy: {} }).where(eq(repositories.id, repoId));
      await db.delete(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, "main")));
    }
  });

  it("the per-repo opt-out (dismissStaleApprovals:false) keeps approvals sticky", async () => {
    await db.update(repositories).set({ mergePolicy: { dismissStaleApprovals: false } }).where(eq(repositories.id, repoId));
    try {
      const id = await newChange();
      await review(id, { verdict: "approve", basis: "code" });
      await db.update(changes).set({ headCommit: COMMIT_B }).where(eq(changes.id, id));
      expect((await svc.evaluate(id)).mergeable).toBe(true);
    } finally {
      await db.update(repositories).set({ mergePolicy: {} }).where(eq(repositories.id, repoId));
    }
  });

  it("GET /reviews surfaces the dismissed approval as stale instead of dropping it silently", async () => {
    const id = await newChange();
    await review(id, { verdict: "approve", basis: "code" });
    await push(id, COMMIT_B);
    const res = await app.request(`/api/v1/repos/${ns}/${repoName}/changes/${id}/reviews`, {
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    const { reviews: rows } = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].stale).toBe(true);
    expect(rows[0].headCommit).toBe(COMMIT_A);

    // Once the reviewer re-approves the new head, only the live verdict shows.
    await review(id, { verdict: "approve", basis: "code" });
    const res2 = await app.request(`/api/v1/repos/${ns}/${repoName}/changes/${id}/reviews`, {
      headers: { authorization: `Bearer ${reviewerToken}` },
    });
    const { reviews: rows2 } = await res2.json();
    expect(rows2).toHaveLength(1);
    expect(rows2[0].stale).toBe(false);
    expect(rows2[0].headCommit).toBe(COMMIT_B);
  });
});
