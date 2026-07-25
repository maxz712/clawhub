import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import { organizations, ssoProviders, ssoStates, users } from "../src/models/schema.js";

// url-guard's assertPublicHttpHost does a real DNS lookup; stub it to "allowed"
// so the flow reaches the (mocked) IdP endpoints without touching the network.
vi.mock("../src/services/url-guard.js", () => ({
  assertPublicHttpHost: vi.fn(async () => false),
}));

const { completeOidcFlow } = await import("../src/services/oidc.js");

// DB-backed regression test for issue #90 — OIDC state must be consumed atomically
// (delete-returning) as the FIRST action so a captured (state, code) pair can't be
// replayed. Runs only when a Postgres test DB is configured; skipped otherwise so
// the default pure suite is unaffected. Mirrors memory-db.test.ts.
//
//   CLAWHUB_TEST_DATABASE_URL=postgresql://clawhub:clawhub@localhost:5432/clawhub npx vitest run tests/oidc.test.ts
const TEST_URL = process.env.CLAWHUB_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("completeOidcFlow — single-use state (issue #90)", () => {
  const client = TEST_URL ? postgres(TEST_URL, { max: 4 }) : null!;
  const db = TEST_URL ? drizzle(client, { schema }) : null!;
  let orgId: string;
  let providerId: string;
  let seedN = 0;

  // A discovery + token + userinfo IdP stub keyed off the request URL, so the flow
  // can complete end-to-end without any real network I/O.
  function stubIdp(email: string) {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      if (url.includes("/.well-known/openid-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://idp.example.com/authorize",
          token_endpoint: "https://idp.example.com/token",
          userinfo_endpoint: "https://idp.example.com/userinfo",
          jwks_uri: "https://idp.example.com/jwks",
        });
      }
      if (url.includes("/token")) return jsonResponse({ access_token: "at-abc" });
      if (url.includes("/userinfo")) return jsonResponse({ email, email_verified: true, name: "SSO User" });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function jsonResponse(body: unknown) {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }

  // A fresh provider config each test — a unique issuer sidesteps oidc.ts's
  // in-process discovery cache so the stub is always consulted.
  async function seedState(): Promise<string> {
    const state = `st-${Date.now()}-${seedN++}-${Math.floor(Math.random() * 1e6)}`;
    await db.insert(ssoStates).values({
      state,
      providerId,
      codeVerifier: "verifier-xyz",
      redirectTo: "/dashboard",
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return state;
  }

  beforeAll(async () => {
    const [org] = await db.insert(organizations).values({ name: `oidc-test-${Date.now()}` }).returning();
    orgId = org.id;
    const [provider] = await db.insert(ssoProviders).values({
      orgId,
      kind: "oidc",
      name: "test-oidc",
      enabled: true,
      config: {
        issuer: `https://idp-${Date.now()}.example.com`,
        clientId: "client-1",
        clientSecret: "secret-1",
        redirectUri: "https://app.example.com/sso/callback",
      },
    }).returning();
    providerId = provider.id;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
    await client?.end();
  });

  it("consumes the state row on a successful login (single use)", async () => {
    const email = `oidc-ok-${Date.now()}@example.test`;
    stubIdp(email);
    const state = await seedState();

    const res = await completeOidcFlow(db, state, "authcode-1");
    expect(res.userId).toBeTruthy();
    expect(res.redirectTo).toBe("/dashboard");

    // Row is gone — a replay of the same state now fails.
    const left = await db.select().from(ssoStates).where(eq(ssoStates.state, state));
    expect(left.length).toBe(0);
    await expect(completeOidcFlow(db, state, "authcode-1")).rejects.toThrow("sso_state_not_found");

    await db.delete(users).where(eq(users.email, email.toLowerCase()));
  });

  it("rejects an unknown/already-consumed state BEFORE any IdP round-trip", async () => {
    const fetchMock = stubIdp(`never-${Date.now()}@example.test`);
    await expect(completeOidcFlow(db, "does-not-exist", "authcode-x")).rejects.toThrow("sso_state_not_found");
    // The fix consumes (and fails) before reaching discovery/token/userinfo.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("two concurrent completes on the same state — exactly one succeeds, the other is rejected", async () => {
    const email = `oidc-race-${Date.now()}@example.test`;
    stubIdp(email);
    const state = await seedState();

    const results = await Promise.allSettled([
      completeOidcFlow(db, state, "authcode-race"),
      completeOidcFlow(db, state, "authcode-race"),
    ]);

    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason?.message)).toContain("sso_state_not_found");

    await db.delete(users).where(eq(users.email, email.toLowerCase()));
  });
});
