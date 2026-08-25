import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import {
  agents, auditEvents, organizations, orgMembers, platformUsage, repositories, standingAgents, users,
} from "../src/models/schema.js";
import { hashPassword, hashToken, signToken } from "../src/services/auth.js";
import { GitService } from "../src/services/git.js";
import { makeRevocationChecker } from "../src/services/token-revocation.js";
import { createScimToken } from "../src/services/scim-tokens.js";

process.env.JWT_SECRET ??= "test-secret-scim";
// This suite isolates its rate-limit bucket via a per-suite CF-Connecting-IP.
// Post-#159 that header is honoured ONLY when a trusted edge is declared, so
// declare one here (this env is scoped to this test file's worker process).
process.env.CLAWHUB_TRUSTED_PROXY_COUNT ??= "1";
process.env.CLAWHUB_TRUSTED_PROXY_HEADER ??= "cf-connecting-ip";

// Regression coverage for #133 — SCIM deprovisioning was broken in BOTH
// directions:
//
//  (1) `active:false` (the operation Okta / Azure AD send by default when an
//      employee leaves) fell through the PATCH loop untouched and was answered
//      200 with a body that hardcoded `"active": true`. The IdP recorded a
//      successful deprovision; the human kept every session, token and grant.
//  (2) `DELETE` ran a raw `db.delete(users)`, bypassing the ONE deletion
//      cascade — leaving live-tokened ownerless agents and, worse, the
//      deleted user's private bare repos on disk under a handle anyone could
//      then claim and push to (auto-repo adopts an existing directory).
//
// Plus: no org scoping at all (one instance-wide token; `GET /Users` returned
// every user on the instance), a non-timing-safe token compare, no handles on
// provisioned users, and no audit events.
const INSTANCE_TOKEN = `instance-scim-token-${Date.now()}`;

describe.skipIf(!hasTestDb)("SCIM deprovisioning (#133)", () => {
  const S = Date.now();
  let app: Hono;
  let git: GitService;
  let gitBase: string;
  const prevEnvToken = process.env.CLAWHUB_SCIM_TOKEN;

  beforeAll(async () => {
    process.env.CLAWHUB_SCIM_TOKEN = INSTANCE_TOKEN;
    // buildApp reads these when it installs the limiters; the suite drives far
    // more than 100 requests/min from one "IP" and the auth bucket is 5/min.
    process.env.CLAWHUB_API_RATE_LIMIT ??= "100000";
    process.env.CLAWHUB_AUTH_RATE_LIMIT ??= "100000";
    const { buildApp } = await import("../src/app.js");
    const { EventBus } = await import("../src/services/events.js");
    gitBase = await mkdtemp(join(tmpdir(), "clawhub-scim-test-"));
    git = new GitService(gitBase);
    app = buildApp({ db, git, events: new EventBus(), inProcessWorker: false });
  });

  afterAll(() => {
    if (prevEnvToken === undefined) delete process.env.CLAWHUB_SCIM_TOKEN;
    else process.env.CLAWHUB_SCIM_TOKEN = prevEnvToken;
  });

  // --- helpers -------------------------------------------------------------

  let seq = 0;
  async function makeUser(tag: string, password = "correct-horse-battery-1") {
    const n = ++seq;
    const email = `scim-${tag}-${n}-${S}@t.co`;
    const [u] = await db.insert(users).values({
      email, username: `scim${tag}${n}${S}`, passwordHash: await hashPassword(password),
    }).returning();
    return u;
  }

  async function makeOrg(tag: string) {
    const [o] = await db.insert(organizations).values({ name: `scim-org-${tag}-${++seq}-${S}` }).returning();
    return o;
  }

  async function orgToken(orgId: string) {
    const { token } = await createScimToken(db, orgId, `okta-${++seq}`, null);
    return token;
  }

  // The rate limiter buckets per client IP in a SHARED Redis, so a suite that
  // drives hundreds of requests must claim its own key or it collides with
  // whatever else vitest is running and 429s instead of asserting.
  const CLIENT_IP = `203.0.113.${(S % 200) + 1}`;

  function scim(path: string, init: RequestInit & { token?: string } = {}) {
    const { token = INSTANCE_TOKEN, ...rest } = init;
    return app.request(`/api/v1/scim/v2${path}`, {
      ...rest,
      headers: {
        "content-type": "application/scim+json",
        "cf-connecting-ip": CLIENT_IP,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    });
  }

  const patch = (id: string, ops: unknown[], token?: string) =>
    scim(`/Users/${id}`, { method: "PATCH", body: JSON.stringify({ Operations: ops }), token });

  const reload = async (id: string) =>
    (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];

  // --- auth ----------------------------------------------------------------

  it("fails closed: no bearer, a wrong token, and an unset env token are all 401", async () => {
    const anyUser = await makeUser("authprobe");

    expect((await scim("/Users", { token: "" })).status).toBe(401);
    expect((await scim("/Users", { token: "not-the-token" })).status).toBe(401);
    // A near-miss on the env token (correct prefix, wrong length) must not pass
    // — the compare is on full buffers, constant time.
    expect((await scim("/Users", { token: INSTANCE_TOKEN.slice(0, -1) })).status).toBe(401);

    // Unset/empty CLAWHUB_SCIM_TOKEN can never match, even with an empty bearer.
    process.env.CLAWHUB_SCIM_TOKEN = "";
    try {
      expect((await scim(`/Users/${anyUser.id}`, { token: "" })).status).toBe(401);
      expect((await scim(`/Users/${anyUser.id}`, { token: " " })).status).toBe(401);
    } finally {
      process.env.CLAWHUB_SCIM_TOKEN = INSTANCE_TOKEN;
    }
  });

  // --- leg 1: active:false actually disables -------------------------------

  it("PATCH active:false — pathless (Okta) form — disables and reports active:false", async () => {
    const u = await makeUser("okta");
    const res = await patch(u.id, [{ op: "replace", value: { active: false } }]);
    expect(res.status).toBe(200);
    expect((await res.json() as { active: boolean }).active).toBe(false);

    const after = await reload(u.id);
    expect(after.disabledAt).not.toBeNull();
    // token_version bumped, so revocation is immediate rather than TTL-bounded.
    expect(after.tokenVersion).toBe(u.tokenVersion + 1);
  });

  it("PATCH active:false — path form, and Azure AD's string \"False\" — both disable", async () => {
    const a = await makeUser("pathform");
    expect((await patch(a.id, [{ op: "replace", path: "active", value: false }])).status).toBe(200);
    expect((await reload(a.id)).disabledAt).not.toBeNull();

    const b = await makeUser("azure");
    expect((await patch(b.id, [{ op: "Replace", path: "active", value: "False" }])).status).toBe(200);
    expect((await reload(b.id)).disabledAt).not.toBeNull();
  });

  it("a disabled user's existing JWT is rejected at the auth boundary and they cannot log in", async () => {
    const password = "correct-horse-battery-1";
    const u = await makeUser("session", password);
    const jwt = signToken({ kind: "user", userId: u.id, email: u.email, v: u.tokenVersion });
    const isValid = makeRevocationChecker(db);

    // Live before the deprovision.
    expect(await isValid({ kind: "user", userId: u.id, email: u.email, v: u.tokenVersion }, jwt)).toBe(true);
    const before = await app.request("/api/v1/users/me", { headers: { authorization: `Bearer ${jwt}`, "cf-connecting-ip": CLIENT_IP } });
    expect(before.status).toBe(200);

    expect((await patch(u.id, [{ op: "replace", value: { active: false } }])).status).toBe(200);

    expect(await isValid({ kind: "user", userId: u.id, email: u.email, v: u.tokenVersion }, jwt)).toBe(false);
    // ...and a token minted DURING the disabled window (right `v`) is dead too.
    const fresh = await reload(u.id);
    const reminted = signToken({ kind: "user", userId: u.id, email: u.email, v: fresh.tokenVersion });
    expect(await isValid({ kind: "user", userId: u.id, email: u.email, v: fresh.tokenVersion }, reminted)).toBe(false);

    const login = await app.request("/api/v1/users/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": CLIENT_IP },
      body: JSON.stringify({ email: u.email, password }),
    });
    expect(login.status).toBe(401);
  });

  it("active:true re-enables and the response round-trips", async () => {
    const u = await makeUser("rehire");
    await patch(u.id, [{ op: "replace", value: { active: false } }]);
    expect((await reload(u.id)).disabledAt).not.toBeNull();

    const res = await patch(u.id, [{ op: "replace", path: "active", value: true }]);
    expect(res.status).toBe(200);
    expect((await res.json() as { active: boolean }).active).toBe(true);
    expect((await reload(u.id)).disabledAt).toBeNull();

    // The serializer derives `active`; it no longer hardcodes true.
    const get = await scim(`/Users/${u.id}`);
    expect((await get.json() as { active: boolean }).active).toBe(true);
    await patch(u.id, [{ op: "replace", value: { active: false } }]);
    const disabled = await scim(`/Users/${u.id}`);
    expect((await disabled.json() as { active: boolean }).active).toBe(false);
  });

  it("an operation the server does not implement is a 4xx, and nothing is applied", async () => {
    const u = await makeUser("unknownop");
    const cases: unknown[][] = [
      [{ op: "replace", path: "userName", value: "someone-else@t.co" }],
      [{ op: "remove", path: "active" }],
      [{ op: "replace", path: "active", value: "maybe" }],
      // A valid op alongside an unsupported one is rejected WHOLE — a partial
      // apply would leave the account in a state neither side believes in.
      [{ op: "replace", value: { active: false } }, { op: "replace", path: "emails", value: [] }],
    ];
    for (const ops of cases) {
      const res = await patch(u.id, ops);
      expect(res.status, JSON.stringify(ops)).toBe(400);
      expect((await res.json() as { schemas: string[] }).schemas)
        .toContain("urn:ietf:params:scim:api:messages:2.0:Error");
    }
    const after = await reload(u.id);
    expect(after.disabledAt).toBeNull();
    expect(after.email).toBe(u.email);
  });

  // --- leg 2: DELETE runs the one cascade ----------------------------------

  it("DELETE runs the GDPR cascade: agents archived + token-revoked, deployments gone, repos gone from DB and disk", async () => {
    const victim = await makeUser("deprovision");
    const username = victim.username!;

    const [repo] = await db.insert(repositories).values({
      name: "secret", namespaceType: "user", namespaceId: victim.id, isPublic: false,
    }).returning();
    await git.initBare(username, "secret");
    expect(await git.exists(username, "secret")).toBe(true);

    const agentId = crypto.randomUUID();
    const agentJwt = signToken({ kind: "agent", agentId, name: `scim-agent-${S}` });
    const [agent] = await db.insert(agents).values({
      id: agentId, name: `scim-agent-${S}`, tokenHash: await hashToken(agentJwt),
      associatedUserId: victim.id,
      gitAuthorName: "Departing Human", gitAuthorEmail: victim.email,
    }).returning();
    const [deployment] = await db.insert(standingAgents).values({
      repoId: repo.id, agentId: agent.id, name: `scim-standing-${S}`, image: "clawhub/harness:latest",
      tokenCiphertext: "sealed", tokenNonce: "nonce",
    }).returning();
    const [usage] = await db.insert(platformUsage).values({
      userId: victim.id, model: "claude-sonnet-5", costMicroUsd: 4200,
    }).returning();
    await db.insert(auditEvents).values({
      actorKind: "human", actorId: victim.id, actorHandle: username, action: "user.login", category: "auth",
    });

    const isValid = makeRevocationChecker(db);
    expect(await isValid({ kind: "agent", agentId: agent.id, name: agent.name }, agentJwt)).toBe(true);

    const res = await scim(`/Users/${victim.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    // The user is gone...
    expect(await reload(victim.id)).toBeUndefined();
    // ...and so is the ownerless fleet the raw delete used to leave behind.
    const agentAfter = (await db.select().from(agents).where(eq(agents.id, agent.id)).limit(1))[0];
    expect(agentAfter.archivedAt).not.toBeNull();
    expect(agentAfter.tokenHash).toBe("archived");
    expect(await isValid({ kind: "agent", agentId: agent.id, name: agent.name }, agentJwt)).toBe(false);
    expect((await db.select().from(standingAgents).where(eq(standingAgents.id, deployment.id)).limit(1))[0])
      .toBeUndefined();

    // Own-namespace repositories: DB row deleted, not orphaned.
    expect((await db.select().from(repositories).where(eq(repositories.id, repo.id)).limit(1))[0])
      .toBeUndefined();

    // Billing amounts retained, personal attribution scrubbed.
    const usageAfter = (await db.select().from(platformUsage).where(eq(platformUsage.id, usage.id)).limit(1))[0];
    expect(usageAfter.userId).toBeNull();
    expect(usageAfter.costMicroUsd).toBe(4200);

    // Audit events retained, attribution scrubbed.
    const orphanedAudit = await db.select().from(auditEvents)
      .where(and(eq(auditEvents.actorKind, "human"), eq(auditEvents.actorId, victim.id)));
    expect(orphanedAudit).toHaveLength(0);
    const deleteEvent = await db.select().from(auditEvents).where(eq(auditEvents.action, "scim.user.deleted"));
    expect(deleteEvent.length).toBeGreaterThan(0);
  });

  // The adoption chain from the issue (2c): the handle frees up, disk paths are
  // keyed by NAME, and auto-repo adopts an existing directory instead of
  // creating one — so a raw `db.delete(users)` handed the next holder of the
  // handle every object and ref of the deleted user's private history. This
  // test fails on the pre-fix code, where the bare repo survived.
  it("after a SCIM delete the freed handle cannot inherit the deleted user's git objects", async () => {
    const victim = await makeUser("adopt");
    const username = victim.username!;
    await db.insert(repositories).values({
      name: "secret", namespaceType: "user", namespaceId: victim.id, isPublic: false,
    });
    await git.initBare(username, "secret");
    expect(await git.exists(username, "secret")).toBe(true);

    expect((await scim(`/Users/${victim.id}`, { method: "DELETE" })).status).toBe(204);

    // Nothing left on disk for a new `alice` to adopt.
    expect(await git.exists(username, "secret")).toBe(false);
  });

  it("DELETE of a nonexistent or malformed id is 404, never 204", async () => {
    expect((await scim(`/Users/${crypto.randomUUID()}`, { method: "DELETE" })).status).toBe(404);
    expect((await scim("/Users/not-a-uuid", { method: "DELETE" })).status).toBe(404);
    expect((await scim("/Users/not-a-uuid")).status).toBe(404);
    expect((await patch("not-a-uuid", [{ op: "replace", value: { active: false } }])).status).toBe(404);
  });

  // --- org scoping ---------------------------------------------------------

  it("an org token sees only its own org's users; a foreign id 404s on GET, PATCH and DELETE", async () => {
    const acme = await makeOrg("acme");
    const globex = await makeOrg("globex");
    const acmeUser = await makeUser("acmeuser");
    const globexUser = await makeUser("globexuser");
    await db.insert(orgMembers).values([
      { orgId: acme.id, userId: acmeUser.id },
      { orgId: globex.id, userId: globexUser.id },
    ]);
    const acmeToken = await orgToken(acme.id);

    const list = await scim("/Users", { token: acmeToken });
    expect(list.status).toBe(200);
    const ids = (await list.json() as { Resources: Array<{ id: string }> }).Resources.map(r => r.id);
    expect(ids).toContain(acmeUser.id);
    expect(ids).not.toContain(globexUser.id);

    // The userName filter cannot reach across the boundary either.
    const filtered = await scim(`/Users?filter=${encodeURIComponent(`userName eq "${globexUser.email}"`)}`, { token: acmeToken });
    expect((await filtered.json() as { Resources: unknown[] }).Resources).toHaveLength(0);

    expect((await scim(`/Users/${globexUser.id}`, { token: acmeToken })).status).toBe(404);
    expect((await patch(globexUser.id, [{ op: "replace", value: { active: false } }], acmeToken)).status).toBe(404);
    expect((await scim(`/Users/${globexUser.id}`, { method: "DELETE", token: acmeToken })).status).toBe(404);

    // The neighbour is untouched by any of it.
    const survivor = await reload(globexUser.id);
    expect(survivor).toBeDefined();
    expect(survivor.disabledAt).toBeNull();
  });

  it("POST provisions into the calling token's org with a resolvable handle", async () => {
    const org = await makeOrg("provision");
    const token = await orgToken(org.id);
    const email = `SCIM-New-${++seq}-${S}@T.co`;

    const res = await scim("/Users", {
      method: "POST", token,
      body: JSON.stringify({ userName: email, displayName: "New Hire" }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { id: string; userName: string; active: boolean };
    expect(created.active).toBe(true);
    // Addresses normalize — one address is one account.
    expect(created.userName).toBe(email.toLowerCase());

    const row = await reload(created.id);
    expect(row.username, "a provisioned user needs a handle to be a namespace").toBeTruthy();
    const membership = (await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, created.id))).limit(1))[0];
    expect(membership).toBeDefined();

    // Idempotent re-provision (the IdP retries) returns the same account, 200.
    const again = await scim("/Users", {
      method: "POST", token, body: JSON.stringify({ userName: email.toLowerCase() }),
    });
    expect(again.status).toBe(200);
    expect((await again.json() as { id: string }).id).toBe(created.id);

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "scim.user.provisioned"));
    expect(events.length).toBeGreaterThan(0);

    // An IdP that provisions an already-inactive account is honoured, not
    // quietly handed an active one.
    const inactive = await scim("/Users", {
      method: "POST", token,
      body: JSON.stringify({ userName: `scim-dormant-${++seq}-${S}@t.co`, active: false }),
    });
    expect(inactive.status).toBe(201);
    expect((await inactive.json() as { active: boolean }).active).toBe(false);
  });

  it("service accounts are invisible to SCIM — an IdP cannot enumerate or delete one", async () => {
    const [svc] = await db.insert(users).values({
      email: `scim-svc-${++seq}-${S}@t.co`, username: `scimsvc${seq}${S}`, kind: "service",
      passwordHash: await hashPassword("unguessable-service-account-pw"),
    }).returning();
    expect((await scim(`/Users/${svc.id}`)).status).toBe(404);
    expect((await scim(`/Users/${svc.id}`, { method: "DELETE" })).status).toBe(404);
    const list = await scim("/Users");
    const ids = (await list.json() as { Resources: Array<{ id: string }> }).Resources.map(r => r.id);
    expect(ids).not.toContain(svc.id);
  });

  it("every mutation is audited", async () => {
    const u = await makeUser("audited");
    await patch(u.id, [{ op: "replace", value: { active: false } }]);
    await patch(u.id, [{ op: "replace", value: { active: true } }]);
    await patch(u.id, [{ op: "replace", path: "displayName", value: "Renamed By IdP" }]);
    const actions = (await db.select().from(auditEvents)).map(e => e.action);
    expect(actions).toContain("scim.user.deactivated");
    expect(actions).toContain("scim.user.reactivated");
    expect(actions).toContain("scim.user.updated");
  });
});
