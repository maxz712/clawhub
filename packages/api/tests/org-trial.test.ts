// Regression coverage for #110: an org's free trial could be restarted
// indefinitely — startTrial upserted with onConflictDoUpdate, resetting endsAt
// on every call, so an org admin could hold the paid tier forever for free.
// The trial is now strictly once per org: startTrial is insert-only and a
// restart throws 409 trial_already_used; an expired trial never re-grants.
import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { testDb, hasTestDb } from "./test-db.js";
import { organizations, orgMembers, orgTrials, users } from "../src/models/schema.js";
import { activeTrial, startTrial, trialUsed } from "../src/services/invites.js";
import { planFor } from "../src/services/entitlements.js";
import { createBillingRoutes } from "../src/routes/billing.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";

process.env.JWT_SECRET ??= "test-secret-org-trial";

describe.skipIf(!hasTestDb)("#110 org trial is once per org (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];

  async function mkUser(prefix: string) {
    const handle = `${prefix}-${uniq()}`;
    const [u] = await testDb.insert(users).values({
      email: `${handle}@t.local`, username: handle, passwordHash: "x",
    }).returning();
    createdUsers.push(u.id);
    return u;
  }

  async function mkOrg(adminUserId?: string) {
    const [org] = await testDb.insert(organizations).values({ name: `trial-org-${uniq()}` }).returning();
    createdOrgs.push(org.id);
    if (adminUserId) await testDb.insert(orgMembers).values({ orgId: org.id, userId: adminUserId, role: "admin" });
    return org;
  }

  afterAll(async () => {
    if (!hasTestDb) return;
    // org_trials + org_members cascade off organizations.
    if (createdOrgs.length) await testDb.delete(organizations).where(inArray(organizations.id, createdOrgs));
    if (createdUsers.length) await testDb.delete(users).where(inArray(users.id, createdUsers));
  });

  it("first trial works: never-trialed org gets the plan for its window, expiry demotes to free", async () => {
    const org = await mkOrg();
    expect(await trialUsed(testDb, org.id)).toBe(false);
    expect(await planFor(testDb, { orgId: org.id })).toBe("free");

    await startTrial(testDb, org.id);
    const trial = await activeTrial(testDb, org.id);
    expect(trial).not.toBeNull();
    expect(trial!.plan).toBe("team");
    expect(await planFor(testDb, { orgId: org.id })).toBe("team");
    expect(await trialUsed(testDb, org.id)).toBe(true);

    // Expire the window: the plan demotes back to free.
    await testDb.update(orgTrials).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(orgTrials.orgId, org.id));
    expect(await activeTrial(testDb, org.id)).toBeNull();
    expect(await planFor(testDb, { orgId: org.id })).toBe("free");
  });

  it("a second startTrial rejects with trial_already_used and does not touch endsAt/plan", async () => {
    const org = await mkOrg();
    await startTrial(testDb, org.id);
    const before = (await testDb.select().from(orgTrials).where(eq(orgTrials.orgId, org.id)))[0];

    await expect(startTrial(testDb, org.id)).rejects.toMatchObject({ status: 409, code: "trial_already_used" });

    const after = (await testDb.select().from(orgTrials).where(eq(orgTrials.orgId, org.id)))[0];
    expect(after.endsAt.getTime()).toBe(before.endsAt.getTime());
    expect(after.plan).toBe(before.plan);
  });

  it("post-expiry restart is rejected and the org stays free", async () => {
    const org = await mkOrg();
    await startTrial(testDb, org.id);
    await testDb.update(orgTrials).set({ endsAt: new Date(Date.now() - 1000) }).where(eq(orgTrials.orgId, org.id));
    expect(await planFor(testDb, { orgId: org.id })).toBe("free");

    await expect(startTrial(testDb, org.id)).rejects.toMatchObject({ status: 409, code: "trial_already_used" });
    // Still expired, still free — no fresh window was minted.
    expect(await activeTrial(testDb, org.id)).toBeNull();
    expect(await planFor(testDb, { orgId: org.id })).toBe("free");
  });

  it("endpoint: second POST /orgs/:id/trial/start → 409 trial_already_used; subscription GET reports trialUsed", async () => {
    const admin = await mkUser("trialadmin");
    const org = await mkOrg(admin.id);
    const app = new Hono();
    app.route("/api/v1/billing", createBillingRoutes(testDb, "https://example.test").auth);
    app.onError(errorHandler);
    const headers = { authorization: `Bearer ${signToken({ kind: "user", userId: admin.id, email: admin.email })}` };

    const first = await app.request(`/api/v1/billing/orgs/${org.id}/trial/start`, { method: "POST", headers });
    expect(first.status).toBe(200);
    const startedEndsAt = (await activeTrial(testDb, org.id))!.endsAt.getTime();

    const second = await app.request(`/api/v1/billing/orgs/${org.id}/trial/start`, { method: "POST", headers });
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toBe("trial_already_used");
    // Exactly one bounded window — the restart attempt didn't extend it.
    expect((await activeTrial(testDb, org.id))!.endsAt.getTime()).toBe(startedEndsAt);

    const sub = await app.request(`/api/v1/billing/orgs/${org.id}/subscription`, { headers });
    expect(sub.status).toBe(200);
    const body = await sub.json() as { trial: unknown; trialUsed: boolean };
    expect(body.trialUsed).toBe(true);
    expect(body.trial).not.toBeNull();
  });
});
