import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { issueComments, issues, mentions, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { EventBus } from "../src/services/events.js";
import { createIssueRoutes } from "../src/routes/issues.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Issue #117: posting an issue comment requires REVIEW access (reviewer/write/
// admin), matching the change-comment route (comments.ts). A read-only caller
// on a public repo must get 403 with no issue_comments row written and no
// @mention fan-out; reviewer+ callers are unaffected.
const S = Date.now();
let app: Hono, ns: string, repoName: string, issueId: string;
let ownerToken: string, readerToken: string, reviewerToken: string;
let ownerUsername: string, readerId: string;

describe.skipIf(!hasTestDb)("issue comment access (#117)", () => {
  beforeAll(async () => {
    const [owner] = await db.insert(users).values({ email: `ica-o-${S}@t.co`, username: `icao${S}`, passwordHash: "x" }).returning();
    const [reader] = await db.insert(users).values({ email: `ica-r-${S}@t.co`, username: `icar${S}`, passwordHash: "x" }).returning();
    const [reviewer] = await db.insert(users).values({ email: `ica-v-${S}@t.co`, username: `icav${S}`, passwordHash: "x" }).returning();
    ns = owner.username!;
    ownerUsername = owner.username!;
    ownerToken = signToken({ kind: "user", userId: owner.id, email: owner.email });
    readerToken = signToken({ kind: "user", userId: reader.id, email: reader.email });
    readerId = reader.id;
    reviewerToken = signToken({ kind: "user", userId: reviewer.id, email: reviewer.email });
    repoName = `icarepo${S}`;
    // PUBLIC repo: any authenticated user gets read — the exact spam vector.
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: owner.id, isPublic: true }).returning();
    await db.insert(repoCollaborators).values({ repoId: r.id, userId: reviewer.id, role: "reviewer" });
    const [iss] = await db.insert(issues).values({ repoId: r.id, number: 1, title: "test issue", createdByKind: "human", createdById: owner.id }).returning();
    issueId = iss.id;
    app = new Hono();
    app.route("/api/v1/repos", createIssueRoutes(db, new EventBus()));
    app.onError(errorHandler);
  });

  const post = (token: string, body: string) => app.request(
    `/api/v1/repos/${ns}/${repoName}/issues/1/comments`,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ body }) },
  );
  const rows = () => db.select().from(issueComments).where(eq(issueComments.issueId, issueId));

  it("a read-only caller is rejected with 403 and writes no row, no mentions", async () => {
    const res = await post(readerToken, `spam spam @${ownerUsername}`);
    expect(res.status).toBe(403);
    expect((await rows()).length).toBe(0);
    const m = await db.select().from(mentions).where(and(eq(mentions.authorKind, "human"), eq(mentions.authorId, readerId)));
    expect(m.length).toBe(0);
  });

  it("a reviewer-grant caller can post and @mentions are recorded", async () => {
    const res = await post(reviewerToken, `looks legit @${ownerUsername}`);
    expect(res.status).toBe(201);
    const all = await rows();
    expect(all.length).toBe(1);
    const m = await db.select().from(mentions).where(and(eq(mentions.sourceKind, "issue_comment"), eq(mentions.sourceId, all[0].id)));
    expect(m.length).toBe(1);
  });

  it("the owner (admin) can still post (no regression)", async () => {
    const res = await post(ownerToken, "owner reply");
    expect(res.status).toBe(201);
    expect((await rows()).length).toBe(2);
  });

  it("read access still lists the issue (read surface unchanged)", async () => {
    const res = await app.request(`/api/v1/repos/${ns}/${repoName}/issues/1`, { headers: { authorization: `Bearer ${readerToken}` } });
    expect(res.status).toBe(200);
  });
});
