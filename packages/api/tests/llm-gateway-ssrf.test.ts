import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { organizations, orgMembers, repositories, ciRuns, users } from "../src/models/schema.js";
import { createLlmGatewayRoutes } from "../src/routes/llm-gateway.js";
import { createBillingRoutes } from "../src/routes/billing.js";
import { setOrgLlmKey } from "../src/services/org-llm-key.js";
import { hashGatewayToken } from "../src/services/llm-gateway.js";
import { signToken } from "../src/services/auth.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Security regression (#210): the LLM gateway — the process holding the platform
// keys + CLAWHUB_SECRETS_KEY, on the Docker network with Postgres/Redis — fetched
// an ORG-supplied baseUrl with NO validation. Any signed-up user creates an org
// (auto-admin), sets baseUrl to http://redis:6379 / 169.254.169.254, triggers a
// platform run, and turns the gateway into a full-read internal proxy. The fix
// validates the org baseUrl (public http(s) only) + pins the IP, at BOTH write
// time (PUT .../llm-key) and forward time (the gateway), with no platform-key
// fallback on a block.

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasTestDb)("#210 LLM gateway — org baseUrl SSRF", () => {
  it("refuses an org baseUrl pointed at loopback and does NOT fetch it", async () => {
    process.env.CLAWHUB_PLATFORM_PROVIDER = "openrouter";
    process.env.CLAWHUB_PLATFORM_OPENAI_KEY = "sk-or-PLATFORM";

    const [owner] = await db.insert(users).values({ email: `ssrf-${Date.now()}@t.co`, username: `ssrfu${Date.now()}`, passwordHash: "x" }).returning();
    const [org] = await db.insert(organizations).values({ name: `ssrforg-${Date.now()}`, ownerUserId: owner.id }).returning();
    const [repo] = await db.insert(repositories).values({ name: `ssrfrepo-${Date.now()}`, namespaceType: "org", namespaceId: org.id, ownerUserId: owner.id }).returning();
    const gwToken = `chgw_ssrf_${Date.now()}`;
    await db.insert(ciRuns).values({ repoId: repo.id, runnerToken: "rt", status: "running", origin: "agent", gatewayTokenHash: hashGatewayToken(gwToken) });
    // A poisoned baseUrl straight at an internal service.
    await setOrgLlmKey(db, org.id, "openai", "sk-or-ORGKEY", "http://127.0.0.1:6379");

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const gw = createLlmGatewayRoutes(db);
    const res = await gw.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${gwToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }], max_tokens: 10 }),
    });

    expect(res.status).toBe(502);
    // The internal host was never contacted.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("127.0.0.1:6379");
    }

    await db.delete(organizations).where(eq(organizations.id, org.id));
    await db.delete(users).where(eq(users.id, owner.id));
  });
});

describe.skipIf(!hasTestDb)("#210 PUT /billing/orgs/:id/llm-key — baseUrl write-time validation", () => {
  async function seed() {
    const [owner] = await db.insert(users).values({ email: `bk-${Date.now()}-${Math.random()}@t.co`, username: `bku${Date.now()}${Math.floor(Math.random()*1e4)}`, passwordHash: "x" }).returning();
    const [org] = await db.insert(organizations).values({ name: `bkorg-${Date.now()}-${Math.floor(Math.random()*1e4)}`, ownerUserId: owner.id }).returning();
    await db.insert(orgMembers).values({ orgId: org.id, userId: owner.id, role: "admin" });
    const token = signToken({ kind: "user", userId: owner.id, email: owner.email });
    const app = new Hono();
    app.onError(errorHandler);
    const billing = createBillingRoutes(db, "http://localhost:3000");
    app.route("/api/v1/billing", billing.auth);
    return { owner, org, token, app };
  }

  async function put(app: Hono, orgId: string, token: string, body: unknown) {
    return app.request(`/api/v1/billing/orgs/${orgId}/llm-key`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects non-public / non-http(s) baseUrls with 400", async () => {
    const { owner, org, token, app } = await seed();
    for (const baseUrl of ["http://127.0.0.1:6379", "http://169.254.169.254/", "http://[::1]/", "file:///etc/passwd"]) {
      const res = await put(app, org.id, token, { provider: "openai", key: "abcdefgh", baseUrl });
      expect(res.status, `baseUrl ${baseUrl}`).toBe(400);
    }
    await db.delete(organizations).where(eq(organizations.id, org.id));
    await db.delete(users).where(eq(users.id, owner.id));
  });

  it("accepts a public baseUrl", async () => {
    const { owner, org, token, app } = await seed();
    const res = await put(app, org.id, token, { provider: "openai", key: "abcdefgh", baseUrl: "https://openrouter.ai/api/v1" });
    expect(res.status).toBe(200);
    await db.delete(organizations).where(eq(organizations.id, org.id));
    await db.delete(users).where(eq(users.id, owner.id));
  });
});
