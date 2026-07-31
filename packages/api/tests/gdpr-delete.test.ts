import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import {
  agents, changes, gdprRequests, repositories, standingAgents, users, workflows,
} from "../src/models/schema.js";
import { requestDeletion } from "../src/services/gdpr.js";
import { makeRevocationChecker } from "../src/services/token-revocation.js";
import { hashPassword, hashToken, signToken } from "../src/services/auth.js";

process.env.JWT_SECRET ??= "test-secret-gdpr-delete";

// Regression coverage for #104: the GDPR deletion cascade
//  (1) silently FAILED (gdpr_requests → 'failed') for any user who had ever
//      opened a Change by human push — changes.opened_by_user_id was RESTRICT,
//      so db.delete(users) threw. Now SET NULL (migration 0070): the delete
//      completes, Change history survives with attribution scrubbed.
//  (2) when it DID succeed, left the user's agents alive with valid tokens and
//      their standing deployments ticking, ownerless. Now the cascade archives
//      + token-revokes every associated agent and deletes their standing rows
//      (cascading workflows) BEFORE the user row goes.
describe.skipIf(!hasTestDb)("gdpr deletion cascade (#104)", () => {
  const S = Date.now();

  async function makeUser(tag: string) {
    const [u] = await db.insert(users).values({
      email: `gdprdel-${tag}-${S}@t.co`,
      username: `gdprdel${tag}${S}`,
      passwordHash: await hashPassword("pw-irrelevant-here-1"),
    }).returning();
    return u;
  }

  /** The cascade runs detached — poll the request row until terminal. */
  async function waitTerminal(requestId: string) {
    for (let i = 0; i < 50; i++) {
      const row = (await db.select().from(gdprRequests).where(eq(gdprRequests.id, requestId)).limit(1))[0];
      if (row && row.status !== "pending") return row;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("gdpr request never left pending");
  }

  it("completes for a human who opened Changes; history survives scrubbed; fleet archived + revoked", async () => {
    // The repo belongs to ANOTHER user so it (and the Change row) must outlive
    // the victim's deletion — the collaborator scenario where RESTRICT used to
    // abort the whole cascade.
    const owner = await makeUser("owner");
    const victim = await makeUser("victim");
    const [repo] = await db.insert(repositories).values({
      name: `gdprdel-repo-${S}`, namespaceType: "user", namespaceId: owner.id,
    }).returning();
    const [change] = await db.insert(changes).values({
      repoId: repo.id, branch: `feat-${S}`, headCommit: "deadbeefcafe",
      intent: "human-pushed change", openedByUserId: victim.id,
    }).returning();

    // An agent with a LIVE token (the JWT is the token; token_hash = sha256 of
    // it, as in agent registration), plus a standing deployment + workflow.
    const agentId = crypto.randomUUID();
    const agentJwt = signToken({ kind: "agent", agentId, name: `gdprdel-agent-${S}` });
    const [agent] = await db.insert(agents).values({
      id: agentId,
      name: `gdprdel-agent-${S}`,
      tokenHash: await hashToken(agentJwt),
      associatedUserId: victim.id,
      gitAuthorName: "Victim Human",
      gitAuthorEmail: victim.email,
    }).returning();
    const isValid = makeRevocationChecker(db);
    expect(await isValid({ kind: "agent", agentId: agent.id, name: agent.name }, agentJwt)).toBe(true);

    const [standing] = await db.insert(standingAgents).values({
      agentId: agent.id, repoId: repo.id, name: "victim-standing", image: "example/agent:latest",
      tokenCiphertext: "sealed", tokenNonce: "nonce",
    }).returning();
    const [workflow] = await db.insert(workflows).values({
      standingAgentId: standing.id, name: "victim-workflow",
    }).returning();

    // A prior export request whose downloadUrl holds the full PII bundle —
    // must be purged by the delete cascade, not survive de-identified.
    const [exportReq] = await db.insert(gdprRequests).values({
      userId: victim.id, kind: "export", status: "ready", downloadUrl: "data:application/json;base64,cGlp",
    }).returning();

    const requestId = await requestDeletion(db, victim.id);
    const request = await waitTerminal(requestId);
    expect(request.status).toBe("done");
    // The completion record survives the user delete, de-identified (user_id
    // SET NULL) — with the old cascade FK the row vanished with the user.
    expect(request.userId).toBeNull();
    // ...while the PII-bearing export row is gone.
    expect((await db.select().from(gdprRequests).where(eq(gdprRequests.id, exportReq.id))).length).toBe(0);

    // User row gone.
    expect((await db.select().from(users).where(eq(users.id, victim.id))).length).toBe(0);

    // Change retained, attribution scrubbed.
    const changeAfter = (await db.select().from(changes).where(eq(changes.id, change.id)))[0];
    expect(changeAfter).toBeTruthy();
    expect(changeAfter.openedByUserId).toBeNull();

    // Agent archived, token revoked via the sentinel hash, author PII scrubbed.
    const agentAfter = (await db.select().from(agents).where(eq(agents.id, agent.id)))[0];
    expect(agentAfter.archivedAt).toBeTruthy();
    expect(agentAfter.tokenHash).toBe("archived");
    expect(agentAfter.gitAuthorEmail).not.toContain(victim.email);
    expect(await isValid({ kind: "agent", agentId: agent.id, name: agent.name }, agentJwt)).toBe(false);

    // Standing deployment + its workflow are gone — the scheduler has nothing
    // left to dispatch.
    expect((await db.select().from(standingAgents).where(eq(standingAgents.id, standing.id))).length).toBe(0);
    expect((await db.select().from(workflows).where(eq(workflows.id, workflow.id))).length).toBe(0);
  });

  it("an already-archived agent keeps its original archive timestamp", async () => {
    const victim = await makeUser("prearch");
    const archivedAt = new Date(Date.now() - 86_400_000);
    const [agent] = await db.insert(agents).values({
      name: `gdprdel-prearch-${S}`, tokenHash: "archived", associatedUserId: victim.id,
      gitAuthorName: "x", gitAuthorEmail: "x@t.co", archivedAt,
    }).returning();

    const request = await waitTerminal(await requestDeletion(db, victim.id));
    expect(request.status).toBe("done");
    const after = (await db.select().from(agents).where(eq(agents.id, agent.id)))[0];
    expect(after.archivedAt?.getTime()).toBe(archivedAt.getTime());
  });

  it("a user with no agents and no changes still deletes cleanly", async () => {
    const victim = await makeUser("plain");
    const request = await waitTerminal(await requestDeletion(db, victim.id));
    expect(request.status).toBe("done");
    expect((await db.select().from(users).where(eq(users.id, victim.id))).length).toBe(0);
  });
});
