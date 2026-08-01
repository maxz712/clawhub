import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { hasTestDb, testDb } from "./test-db.js";
import { createAttestationRoutes } from "../src/routes/attestations.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import { createAttestation } from "../src/services/provenance.js";
import { agents, attestations, changes, repoCollaborators, repositories, users } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

process.env.JWT_SECRET ??= "test-secret-attestation-authz";

// #111: POST /api/v1/attestations used to sign attacker-supplied claims with
// ClawHub's global Ed25519 key with no repo authorization and no
// changeId↔repoId consistency check — any registered agent could mint
// platform-signed provenance forgeries against any tenant's repo/Change.
// The route is now an authorization boundary like its GET siblings.

function buildApp(db: DB): Hono {
  const app = new Hono();
  app.route("/api/v1/attestations", createAttestationRoutes(db));
  app.onError(errorHandler);
  return app;
}

function post(app: Hono, token: string | null, body: unknown) {
  return app.request("/api/v1/attestations", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const SHA = "a".repeat(40);

describe("POST /attestations gating (no DB)", () => {
  // These short-circuit before any DB work, so a fake DB suffices.
  const app = buildApp({} as DB);

  it("401 without a token", async () => {
    const res = await post(app, null, { repoId: "r", commitSha: SHA });
    expect(res.status).toBe(401);
  });

  it("401 for a USER token — attestations are agent-authored", async () => {
    const token = signToken({ kind: "user", userId: "u1", email: "u@t.local" });
    const res = await post(app, token, { repoId: "r", commitSha: SHA });
    expect(res.status).toBe(401);
  });

  it("400 on a non-hex commitSha before touching the DB", async () => {
    const token = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const res = await post(app, token, { repoId: "r", commitSha: "not-a-sha!" });
    expect(res.status).toBe(400);
  });
});

describe.skipIf(!hasTestDb)("#111 attestation forgery closed (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const createdUsers: string[] = [];
  const createdAgents: string[] = [];

  afterAll(async () => {
    if (!hasTestDb) return;
    // repo delete cascades to changes + attestations + collaborator grants.
    if (createdUsers.length) {
      await testDb.delete(repositories).where(inArray(repositories.namespaceId, createdUsers));
      await testDb.delete(users).where(inArray(users.id, createdUsers));
    }
    if (createdAgents.length) await testDb.delete(agents).where(inArray(agents.id, createdAgents));
  });

  async function mkUser(prefix: string) {
    const handle = `${prefix}-${uniq()}`;
    const [u] = await testDb.insert(users).values({
      email: `${handle}@t.local`, username: handle, passwordHash: "x",
    }).returning();
    createdUsers.push(u.id);
    return u;
  }

  async function mkAgent(prefix: string) {
    const [a] = await testDb.insert(agents).values({
      name: `${prefix}-${uniq()}`, tokenHash: "x",
      gitAuthorName: prefix, gitAuthorEmail: `${prefix}@t.local`,
    }).returning();
    createdAgents.push(a.id);
    return a;
  }

  async function mkRepo(ownerId: string, isPublic = false) {
    const [r] = await testDb.insert(repositories).values({
      name: `attest-${uniq()}`, namespaceType: "user", namespaceId: ownerId, isPublic,
    }).returning();
    return r;
  }

  async function mkChange(repoId: string) {
    const [ch] = await testDb.insert(changes).values({
      repoId, branch: `b-${uniq()}`, headCommit: SHA, intent: "test change",
    }).returning();
    return ch;
  }

  async function attestationCount(repoId: string) {
    return (await testDb.select().from(attestations).where(eq(attestations.repoId, repoId))).length;
  }

  it("cross-repo forge: 404 on a private repo the agent has no grant on, nothing inserted", async () => {
    const victim = await mkUser("victim");
    const victimRepo = await mkRepo(victim.id);
    const attacker = await mkAgent("attacker");
    const app = buildApp(testDb);

    const res = await post(app, signToken({ kind: "agent", agentId: attacker.id, name: attacker.name }), {
      repoId: victimRepo.id, commitSha: SHA, modelName: "claude-fable-5", testsRun: true, typechecked: true,
    });
    expect(res.status).toBe(404);
    expect(await attestationCount(victimRepo.id)).toBe(0);
  });

  it("readable-but-not-writable: 403 on a PUBLIC repo with no write grant, nothing inserted", async () => {
    const victim = await mkUser("victim-pub");
    const publicRepo = await mkRepo(victim.id, true);
    const attacker = await mkAgent("attacker-pub");
    const app = buildApp(testDb);

    const res = await post(app, signToken({ kind: "agent", agentId: attacker.id, name: attacker.name }), {
      repoId: publicRepo.id, commitSha: SHA,
    });
    expect(res.status).toBe(403);
    expect(await attestationCount(publicRepo.id)).toBe(0);
  });

  it("changeId belonging to a different repo than repoId: 400, nothing inserted", async () => {
    const victim = await mkUser("victim-x");
    const victimRepo = await mkRepo(victim.id);
    const victimChange = await mkChange(victimRepo.id);
    const owner = await mkUser("owner-x");
    const agent = await mkAgent("agent-x");
    const ownRepo = await mkRepo(owner.id);
    await testDb.insert(repoCollaborators).values({ repoId: ownRepo.id, agentId: agent.id, role: "writer" });
    const app = buildApp(testDb);

    const res = await post(app, signToken({ kind: "agent", agentId: agent.id, name: agent.name }), {
      repoId: ownRepo.id, changeId: victimChange.id, commitSha: SHA,
    });
    expect(res.status).toBe(400);
    expect(await attestationCount(ownRepo.id)).toBe(0);
  });

  it("happy path: a writer-granted agent attests, row is signed + verifies", async () => {
    const owner = await mkUser("owner-ok");
    const agent = await mkAgent("agent-ok");
    const repo = await mkRepo(owner.id);
    const change = await mkChange(repo.id);
    await testDb.insert(repoCollaborators).values({ repoId: repo.id, agentId: agent.id, role: "writer" });
    const app = buildApp(testDb);
    const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });

    const res = await post(app, token, {
      repoId: repo.id, changeId: change.id, commitSha: SHA, modelName: "m", testsRun: true,
    });
    expect(res.status).toBe(201);
    const { attestation } = await res.json();
    expect(attestation.repoId).toBe(repo.id);
    expect(attestation.signature).toBeTruthy();

    // Round-trips through the change listing with a valid signature.
    const list = await app.request(`/api/v1/attestations/change/${change.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()).attestations;
    expect(listed.map((a: { id: string }) => a.id)).toContain(attestation.id);
    expect(listed.find((a: { id: string }) => a.id === attestation.id).verified).toBe(true);
  });

  it("GET /change/:id drops historic forged rows whose repoId differs from the change's repo", async () => {
    const victim = await mkUser("victim-list");
    const victimRepo = await mkRepo(victim.id);
    const victimChange = await mkChange(victimRepo.id);
    const owner = await mkUser("owner-list");
    const forger = await mkAgent("forger-list");
    const forgerRepo = await mkRepo(owner.id);

    // Simulate a pre-fix forged row: attached to the victim's change but keyed
    // to the forger's own repo (the service layer stays dumb by design).
    const forged = await createAttestation(testDb, {
      repoId: forgerRepo.id, changeId: victimChange.id, commitSha: SHA, agentId: forger.id,
    });
    // And one legitimate row on the change's own repo.
    const legit = await createAttestation(testDb, {
      repoId: victimRepo.id, changeId: victimChange.id, commitSha: SHA, agentId: forger.id,
    });

    const app = buildApp(testDb);
    const res = await app.request(`/api/v1/attestations/change/${victimChange.id}`, {
      headers: { authorization: `Bearer ${signToken({ kind: "user", userId: victim.id, email: victim.email })}` },
    });
    expect(res.status).toBe(200);
    const ids = (await res.json()).attestations.map((a: { id: string }) => a.id);
    expect(ids).toContain(legit.id);
    expect(ids).not.toContain(forged.id);
  });
});
