import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import {
  agents, orgMembers, organizations, repoCollaborators, repositories, standingAgents, users,
} from "../src/models/schema.js";
import { hashPassword, hashToken, signToken } from "../src/services/auth.js";
import { GitService } from "../src/services/git.js";
import { assertAgentEnrollable } from "../src/services/org-registry.js";
import { isAgentKilled } from "../src/services/kill-switch.js";

process.env.JWT_SECRET ??= "test-secret-registry";

// #192 — org agent-registry enrollment required no consent from or relationship
// to the target agent, so any signed-up user could self-appoint as governor of
// ANY agent and kill-switch it (instance-wide token revocation). The fix gates
// enrollment on a real org↔agent relationship.

describe.skipIf(!hasTestDb)("org agent-registry enrollment authz (#192)", () => {
  const S = Date.now();
  let seq = 0;
  async function makeUser(tag: string) {
    const [u] = await db.insert(users).values({
      email: `reg-${tag}-${++seq}-${S}@t.co`, username: `reg${tag}${seq}${S}`, passwordHash: await hashPassword("x"),
    }).returning();
    return u;
  }
  async function makeOrg() {
    const [o] = await db.insert(organizations).values({ name: `reg-org-${++seq}-${S}` }).returning();
    return o;
  }
  async function makeAgent(ownerUserId: string | null) {
    const [a] = await db.insert(agents).values({
      name: `reg-agent-${++seq}-${S}`, tokenHash: await hashToken(`tok-${seq}`), associatedUserId: ownerUserId,
      gitAuthorName: `reg-agent-${seq}`, gitAuthorEmail: `reg-agent-${seq}@t.co`,
    }).returning();
    return a;
  }
  async function makeOrgRepo(orgId: string) {
    const [r] = await db.insert(repositories).values({
      name: `reg-repo-${++seq}-${S}`, namespaceType: "org", namespaceId: orgId,
    }).returning();
    return r;
  }

  it("REJECTS enrolling an agent with no relationship to the org (403)", async () => {
    const org = await makeOrg();
    const stranger = await makeUser("stranger");
    const victimAgent = await makeAgent(stranger.id);
    await expect(assertAgentEnrollable(db, org.id, victimAgent.id)).rejects.toThrow(/no relationship/);
  });

  it("404s a non-existent agentId (no orphan row inserted)", async () => {
    const org = await makeOrg();
    await expect(assertAgentEnrollable(db, org.id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/agent/);
  });

  it("ALLOWS when the agent owner is an org member", async () => {
    const org = await makeOrg();
    const owner = await makeUser("owner");
    await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, source: "invite_accepted" });
    const agent = await makeAgent(owner.id);
    await expect(assertAgentEnrollable(db, org.id, agent.id)).resolves.toBeUndefined();
  });

  it("ALLOWS when the agent has a standing deployment on an org-owned repo", async () => {
    const org = await makeOrg();
    const outsider = await makeUser("dep");
    const agent = await makeAgent(outsider.id);
    const repo = await makeOrgRepo(org.id);
    await db.insert(standingAgents).values({ repoId: repo.id, agentId: agent.id, name: `sa${seq}`, image: "clawhub-agent-harness:latest", tokenCiphertext: "x", tokenNonce: "y" });
    await expect(assertAgentEnrollable(db, org.id, agent.id)).resolves.toBeUndefined();
  });

  it("ALLOWS when the agent holds a collaborator grant on an org-owned repo", async () => {
    const org = await makeOrg();
    const outsider = await makeUser("collab");
    const agent = await makeAgent(outsider.id);
    const repo = await makeOrgRepo(org.id);
    await db.insert(repoCollaborators).values({ repoId: repo.id, agentId: agent.id, role: "writer" });
    await expect(assertAgentEnrollable(db, org.id, agent.id)).resolves.toBeUndefined();
  });

  describe("end-to-end via the routes", () => {
    let app: Hono;
    beforeAll(async () => {
      process.env.CLAWHUB_API_RATE_LIMIT ??= "100000";
      process.env.CLAWHUB_AUTH_RATE_LIMIT ??= "100000";
      const { buildApp } = await import("../src/app.js");
      const { EventBus } = await import("../src/services/events.js");
      const gitBase = await mkdtemp(join(tmpdir(), "clawhub-reg-test-"));
      app = buildApp({ db, git: new GitService(gitBase), events: new EventBus(), inProcessWorker: false });
    });

    const CLIENT_IP = `203.0.115.${(S % 200) + 1}`;
    function api(path: string, token: string, init: RequestInit = {}) {
      return app.request(`/api/v1${path}`, {
        ...init,
        headers: { "content-type": "application/json", "cf-connecting-ip": CLIENT_IP, authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    }

    it("a self-appointed admin cannot enroll then kill an unrelated agent", async () => {
      // Attacker: fresh account, creates an org (→ admin).
      const attacker = await makeUser("attacker");
      const attackerTok = signToken({ kind: "user", userId: attacker.id, email: attacker.email, v: attacker.tokenVersion });
      const enrollRes = await api(`/orgs`, attackerTok, { method: "POST", body: JSON.stringify({ name: `evil-${S}-${++seq}` }) });
      const org = await enrollRes.json() as { id: string };

      // Victim: another user's agent, no relationship to the attacker's org.
      const bob = await makeUser("bob");
      const victimAgent = await makeAgent(bob.id);

      const enroll = await api(`/orgs/${org.id}/registry`, attackerTok, { method: "POST", body: JSON.stringify({ agentId: victimAgent.id }) });
      expect(enroll.status).toBe(403);

      const kill = await api(`/agents/${victimAgent.id}/kill-switch`, attackerTok, { method: "POST", body: JSON.stringify({ reason: "x" }) });
      expect(kill.status).toBe(403);
      expect(await isAgentKilled(db, victimAgent.id)).toBe(false);
    });
  });
});
