import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { changes, repositories, reviews, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { EventBus } from "../src/services/events.js";
import { createReviewRoutes } from "../src/routes/reviews.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Review idempotency (anti-double-submit / the "Approve spam freeze" fix): the
// same reviewer re-submitting an identical stance (verdict + basis + summary) is a
// no-op; a changed verdict/basis/summary is a real change and proceeds.
const S = Date.now();
let app: Hono, token: string, ns: string, repoName: string, changeId: string;

describe.skipIf(!hasTestDb)("review idempotency", () => {
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `ri-${S}@t.co`, username: `riu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    token = signToken({ kind: "user", userId: u.id, email: u.email });
    repoName = `rirepo${S}`;
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id }).returning();
    const [c] = await db.insert(changes).values({ repoId: r.id, branch: "feat", headCommit: "abc12300", intent: "test", status: "pending" }).returning();
    changeId = c.id;
    app = new Hono();
    app.route("/api/v1/repos", createReviewRoutes(db, new EventBus()));
    app.onError(errorHandler);
  });

  const post = (body: Record<string, unknown>) => app.request(
    `/api/v1/repos/${ns}/${repoName}/changes/${changeId}/reviews`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const activeApprove = () => db.select().from(reviews).where(and(
    eq(reviews.changeId, changeId), isNull(reviews.supersededAt), eq(reviews.verdict, "approve"),
  ));

  it("first approve creates a review (201, not idempotent)", async () => {
    const res = await post({ verdict: "approve", basis: "behavior" });
    expect(res.status).toBe(201);
    expect((await res.json()).idempotent).toBeFalsy();
    expect((await activeApprove()).length).toBe(1);
  });

  it("an identical re-approve is a no-op (200 idempotent, no new/superseded row)", async () => {
    const before = await activeApprove();
    const res = await post({ verdict: "approve", basis: "behavior" });
    expect(res.status).toBe(200);
    expect((await res.json()).idempotent).toBe(true);
    const after = await activeApprove();
    expect(after.length).toBe(1);
    expect(after[0].id).toBe(before[0].id); // same review, no churn
  });

  it("a DIFFERENT basis (behavior → both) proceeds and supersedes the old stance", async () => {
    const res = await post({ verdict: "approve", basis: "both" });
    expect(res.status).toBe(201);
    const active = await activeApprove();
    expect(active.length).toBe(1); // still exactly one live approve stance
    expect(active[0].basis).toBe("both");
  });

  it("same basis + changed summary proceeds; same summary no-ops", async () => {
    const r1 = await post({ verdict: "approve", basis: "both", summary: "checked X" });
    expect(r1.status).toBe(201);
    const r2 = await post({ verdict: "approve", basis: "both", summary: "checked X" });
    expect(r2.status).toBe(200);
    expect((await r2.json()).idempotent).toBe(true);
    const r3 = await post({ verdict: "approve", basis: "both", summary: "checked X and Y" });
    expect(r3.status).toBe(201);
  });

  it("comments are additive — never idempotent", async () => {
    const r1 = await post({ verdict: "comment", summary: "note" });
    const r2 = await post({ verdict: "comment", summary: "note" });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect((await r2.json()).idempotent).toBeFalsy();
  });
});
