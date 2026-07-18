import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, issues, repoCollaborators, repositories, users } from "../src/models/schema.js";
import { createIssueRoutes } from "../src/routes/issues.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import type { EventBus } from "../src/services/events.js";

// Issue #77: a manually-assigned issue assignee must hold a collaborator grant on
// the repo — the same guard automatic routing rules already enforce — so an issue
// can never be silently assigned to an agent that can't see or work it. Real DB.
process.env.JWT_SECRET ??= "test-secret-issue-assignee";
const { signToken } = await import("../src/services/auth.js");

const S = Date.now();
let app: Hono;
let ns: string, repoName: string, granted: string, ungranted: string;
let ownerAuth: { headers: { authorization: string } };

async function mkAgent(name: string): Promise<string> {
  const [a] = await db.insert(agents).values({
    name, tokenHash: "x", gitAuthorName: name, gitAuthorEmail: `${name}@t.co`,
  }).returning();
  return a.id;
}

describe.skipIf(!hasTestDb)("issue assignee collaborator validation (#77)", () => {
  beforeAll(async () => {
    ns = `iav${S}`;
    repoName = `iavrepo${S}`;
    const [u] = await db.insert(users).values({ email: `iav-${S}@t.co`, username: ns, passwordHash: "x" }).returning();
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id }).returning();
    granted = await mkAgent(`iav-ok-${S}`);
    ungranted = await mkAgent(`iav-no-${S}`);
    // Only `granted` gets a collaborator grant; `ungranted` intentionally does not.
    await db.insert(repoCollaborators).values({ repoId: r.id, agentId: granted, role: "writer" });
    ownerAuth = { headers: { authorization: `Bearer ${signToken({ kind: "user", userId: u.id, email: `iav-${S}@t.co` })}` } };

    const events = { publish: async () => {}, subscribe: () => () => {} } as unknown as EventBus;
    app = new Hono();
    app.route("/api/v1/repos", createIssueRoutes(db, events));
    app.onError(errorHandler);
  });

  const post = (body: unknown) => app.request(`/api/v1/repos/${ns}/${repoName}/issues`, {
    method: "POST", ...ownerAuth, body: JSON.stringify(body),
  });

  it("rejects creating an issue assigned to an agent with no repo grant", async () => {
    const res = await post({ title: "no-grant assignee", assignedAgentId: ungranted });
    expect(res.status).toBe(400);
    expect((await res.json() as { message?: string }).message).toMatch(/collaborator/i);
  });

  it("accepts creating an issue assigned to a granted collaborator agent", async () => {
    const res = await post({ title: "granted assignee", assignedAgentId: granted });
    expect(res.status).toBe(201);
    const { issue } = await res.json() as { issue: { assignedAgentId: string } };
    expect(issue.assignedAgentId).toBe(granted);
  });

  it("accepts creating an unassigned issue", async () => {
    const res = await post({ title: "unassigned" });
    expect(res.status).toBe(201);
    expect((await res.json() as { issue: { assignedAgentId: string | null } }).issue.assignedAgentId).toBeNull();
  });

  it("rejects PATCH reassigning to an agent with no repo grant, but allows clearing to null", async () => {
    // Seed an issue assigned to the granted agent, then try to reassign it away.
    const created = await post({ title: "patch target", assignedAgentId: granted });
    const num = (await created.json() as { issue: { number: number } }).issue.number;

    const bad = await app.request(`/api/v1/repos/${ns}/${repoName}/issues/${num}`, {
      method: "PATCH", ...ownerAuth, body: JSON.stringify({ assignedAgentId: ungranted }),
    });
    expect(bad.status).toBe(400);

    const cleared = await app.request(`/api/v1/repos/${ns}/${repoName}/issues/${num}`, {
      method: "PATCH", ...ownerAuth, body: JSON.stringify({ assignedAgentId: null }),
    });
    expect(cleared.status).toBe(200);
    const row = (await db.select().from(issues)
      .where(and(eq(issues.repoId, (await db.select().from(repositories).where(eq(repositories.name, repoName)).limit(1))[0].id), eq(issues.number, num))).limit(1))[0];
    expect(row.assignedAgentId).toBeNull();
  });
});
