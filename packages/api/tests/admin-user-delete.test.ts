import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, repositories, standingAgents, users } from "../src/models/schema.js";
import { hashPassword, hashToken, signToken } from "../src/services/auth.js";
import { GitService } from "../src/services/git.js";
import { makeRevocationChecker } from "../src/services/token-revocation.js";

// #170 — admin DELETE /users/:id ran a bare db.delete(users), bypassing the ONE
// deletion cascade: the deleted account's agents kept live tokens + cross-tenant
// grants and its repos orphaned on disk. The fix routes through deleteUserAccount.
const ADMIN_EMAIL = `del-admin-${Date.now()}@t.co`;
process.env.CLAWHUB_ADMIN_EMAILS = ADMIN_EMAIL;
process.env.JWT_SECRET ??= "test-secret-admindel";

describe.skipIf(!hasTestDb)("admin DELETE /users/:id routes through the cascade (#170)", () => {
  const S = Date.now();
  let seq = 0;
  let app: Hono;
  let adminTok: string;

  beforeAll(async () => {
    process.env.CLAWHUB_API_RATE_LIMIT ??= "100000";
    process.env.CLAWHUB_AUTH_RATE_LIMIT ??= "100000";
    const { buildApp } = await import("../src/app.js");
    const { EventBus } = await import("../src/services/events.js");
    const gitBase = await mkdtemp(join(tmpdir(), "clawhub-admindel-test-"));
    app = buildApp({ db, git: new GitService(gitBase), events: new EventBus(), inProcessWorker: false });
    const [admin] = await db.insert(users).values({ email: ADMIN_EMAIL, username: `deladm${S}`, passwordHash: await hashPassword("x") }).returning();
    adminTok = signToken({ kind: "user", userId: admin.id, email: admin.email, v: admin.tokenVersion });
  });

  const CLIENT_IP = `203.0.117.${(S % 200) + 1}`;
  function del(id: string, token = adminTok) {
    return app.request(`/api/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: { "cf-connecting-ip": CLIENT_IP, authorization: `Bearer ${token}` },
    });
  }
  async function makeUser(tag: string) {
    const n = ++seq;
    const [u] = await db.insert(users).values({ email: `del-${tag}-${n}-${S}@t.co`, username: `del${tag}${n}${S}`, passwordHash: await hashPassword("x") }).returning();
    return u;
  }

  it("revokes the deleted user's agent token and drops its standing deployments", async () => {
    const victim = await makeUser("owner");
    const agentToken = signToken({ kind: "agent", agentId: "placeholder", name: "x" });
    const [agent] = await db.insert(agents).values({
      name: `del-agent-${++seq}-${S}`, associatedUserId: victim.id,
      gitAuthorName: "del-agent", gitAuthorEmail: `del-agent-${seq}@t.co`,
      tokenHash: await hashToken(agentToken),
    }).returning();
    const realToken = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
    await db.update(agents).set({ tokenHash: await hashToken(realToken) }).where(eq(agents.id, agent.id));
    const repo = (await db.insert(repositories).values({ name: `del-repo-${seq}`, namespaceType: "user", namespaceId: victim.id }).returning())[0];
    await db.insert(standingAgents).values({ repoId: repo.id, agentId: agent.id, name: `sa${seq}`, image: "clawhub-agent-harness:latest", tokenCiphertext: "c", tokenNonce: "n" });

    const check = makeRevocationChecker(db);
    // Sanity: the agent token verifies BEFORE deletion.
    expect(await check({ kind: "agent", agentId: agent.id, name: agent.name }, realToken)).toBe(true);

    const res = await del(victim.id);
    expect(res.status).toBe(200);

    const after = (await db.select().from(agents).where(eq(agents.id, agent.id)).limit(1))[0];
    expect(after.tokenHash).toBe("archived"); // FAILS on the pre-fix bare delete (row survived untouched)
    expect(after.archivedAt).not.toBeNull();
    // Token no longer verifies.
    expect(await check({ kind: "agent", agentId: agent.id, name: agent.name }, realToken)).toBe(false);
    // Standing deployment gone.
    expect((await db.select().from(standingAgents).where(eq(standingAgents.agentId, agent.id))).length).toBe(0);
    // Owned repo removed from the DB (was orphaned pre-fix).
    expect((await db.select().from(repositories).where(eq(repositories.id, repo.id))).length).toBe(0);
  });

  it("404s an unknown id", async () => {
    const res = await del("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("refuses to delete a service account (400)", async () => {
    const [svc] = await db.insert(users).values({ email: `del-svc-${++seq}-${S}@clawhub.invalid`, username: `delsvc${seq}${S}`, kind: "service", passwordHash: await hashPassword("x") }).returning();
    const res = await del(svc.id);
    expect(res.status).toBe(400);
    expect((await db.select().from(users).where(eq(users.id, svc.id))).length).toBe(1);
  });

  it("rejects a non-admin user and an agent token", async () => {
    const nonAdmin = await makeUser("nonadmin");
    const nonAdminTok = signToken({ kind: "user", userId: nonAdmin.id, email: nonAdmin.email, v: nonAdmin.tokenVersion });
    expect((await del(nonAdmin.id, nonAdminTok)).status).toBe(401);
  });
});
