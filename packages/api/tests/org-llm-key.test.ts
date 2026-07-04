import { describe, it, expect, vi, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { organizations, repositories, ciRuns, users, platformUsage } from "../src/models/schema.js";
import { createLlmGatewayRoutes } from "../src/routes/llm-gateway.js";
import { setOrgLlmKey } from "../src/services/org-llm-key.js";
import { hashGatewayToken } from "../src/services/llm-gateway.js";

// N3 org-connected keys: the gateway must forward an ORG's platform run with the
// ORG's OWN key (not ClawHub's platform key), and meter it as keyOwner='org' so it
// never counts toward ClawHub's global ceiling / overage. Deterministic — the
// upstream fetch is mocked, so no real provider call. (Requires a DB migrated to
// >=0051; run with DATABASE_URL pointed at a migrated test DB.)

const ORG_KEY = "sk-or-TEST-ORGKEY-do-not-use-real";
const PLATFORM_KEY = "sk-or-PLATFORM-must-not-be-used";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!hasTestDb)("N3 org-connected key at the gateway", () => {
  it("forwards with the org's key + meters keyOwner=org (not the platform key)", async () => {
    process.env.CLAWHUB_PLATFORM_PROVIDER = "openrouter";
    process.env.CLAWHUB_PLATFORM_OPENAI_KEY = PLATFORM_KEY;

    // Seed: owner → org → org-owned repo → a RUNNING run pinned to a gateway token.
    const [owner] = await db.insert(users).values({ email: `n3-${Date.now()}@t.co`, username: `n3u${Date.now()}`, passwordHash: "x" }).returning();
    const [org] = await db.insert(organizations).values({ name: `n3org-${Date.now()}`, ownerUserId: owner.id }).returning();
    const [repo] = await db.insert(repositories).values({ name: `n3repo-${Date.now()}`, namespaceType: "org", namespaceId: org.id, ownerUserId: owner.id }).returning();
    const gwToken = `chgw_test_${Date.now()}`;
    await db.insert(ciRuns).values({ repoId: repo.id, runnerToken: "rt", status: "running", origin: "agent", gatewayTokenHash: hashGatewayToken(gwToken) });

    await setOrgLlmKey(db, org.id, "openai", ORG_KEY);

    // Capture the upstream call; return a canned OpenAI-shaped completion + usage.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ model: "z-ai/glm-5.2", choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.00004 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ) as unknown as Response);

    const gw = createLlmGatewayRoutes(db);
    const res = await gw.request("/openai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${gwToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "hi" }], max_tokens: 10 }),
    });

    expect(res.status).toBe(200);
    // The upstream Authorization must carry the ORG key, never the platform key.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const auth = (init.headers as Record<string, string>)["authorization"];
    expect(auth).toBe(`Bearer ${ORG_KEY}`);
    expect(auth).not.toContain(PLATFORM_KEY);

    // Metering recorded the usage marked keyOwner='org'.
    const usage = await db.select().from(platformUsage).where(eq(platformUsage.orgId, org.id));
    expect(usage.length).toBeGreaterThan(0);
    expect((usage[0].meta as { keyOwner?: string })?.keyOwner).toBe("org");

    // cleanup
    await db.delete(organizations).where(eq(organizations.id, org.id)); // cascades repo/run/key/usage
    await db.delete(users).where(eq(users.id, owner.id));
  });
});
