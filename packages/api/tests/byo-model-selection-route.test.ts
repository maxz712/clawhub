import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { llmKeys, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { seal } from "../src/services/secrets.js";
import { EventBus } from "../src/services/events.js";
import { createAgentIdentityRoutes } from "../src/routes/agent-identity.js";
import { ensureDefaultAccessRoles } from "../src/services/access-roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// #72 — "make model selectable for BYO keys": the model dropdown that renders
// below the key dropdown is fed by GET /api/v1/llm-keys/:id/models, and the
// create flow (POST /api/v1/agents/managed) rejects a model that isn't one of
// the key's own provider's selectable models.
const S = Date.now();
let app: Hono, token: string, otherToken: string, anthropicKeyId: string, otherProviderKeyId: string, roleId: string;

describe.skipIf(!hasTestDb)("BYO model selection (#72)", () => {
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `byo-${S}@t.co`, username: `byou${S}`, passwordHash: "x" }).returning();
    const [u2] = await db.insert(users).values({ email: `byo2-${S}@t.co`, username: `byou2${S}`, passwordHash: "x" }).returning();
    token = signToken({ kind: "user", userId: u.id, email: u.email });
    otherToken = signToken({ kind: "user", userId: u2.id, email: u2.email });

    const sealed = seal("sk-ant-test-not-real");
    const [key] = await db.insert(llmKeys).values({
      ownerUserId: u.id, name: "my claude key", provider: "anthropic",
      ciphertext: sealed.ciphertext, nonce: sealed.nonce,
    }).returning();
    anthropicKeyId = key.id;

    const sealed2 = seal("sk-other-test-not-real");
    const [key2] = await db.insert(llmKeys).values({
      ownerUserId: u.id, name: "some other key", provider: "other",
      ciphertext: sealed2.ciphertext, nonce: sealed2.nonce,
    }).returning();
    otherProviderKeyId = key2.id;

    const roles = await ensureDefaultAccessRoles(db, u.id);
    roleId = (roles.find(r => r.name === "Developer") ?? roles[0]).id;

    const identity = createAgentIdentityRoutes(db, new EventBus());
    app = new Hono();
    app.route("/api/v1/llm-keys", identity.keys);
    app.route("/api/v1/agents", identity.managed);
    app.onError(errorHandler);
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

  it("returns a non-empty curated model list for an anthropic key", async () => {
    const res = await app.request(`/api/v1/llm-keys/${anthropicKeyId}/models`, { headers: auth(token) });
    expect(res.status).toBe(200);
    const body = await res.json() as { provider: string; models: Array<{ id: string; label: string }> };
    expect(body.provider).toBe("anthropic");
    expect(body.models.length).toBeGreaterThan(0);
  });

  it("returns an empty list for a provider with no curated catalog", async () => {
    const res = await app.request(`/api/v1/llm-keys/${otherProviderKeyId}/models`, { headers: auth(token) });
    expect(res.status).toBe(200);
    expect((await res.json() as { models: unknown[] }).models).toEqual([]);
  });

  it("404s for a key owned by someone else (no cross-tenant enumeration)", async () => {
    const res = await app.request(`/api/v1/llm-keys/${anthropicKeyId}/models`, { headers: auth(otherToken) });
    expect(res.status).toBe(404);
  });

  it("accepts a BYO deployment pinned to a model in the key's own catalog", async () => {
    const res = await app.request("/api/v1/agents/managed", {
      method: "POST", headers: auth(token),
      body: JSON.stringify({
        name: `byo-agent-ok-${S}`, accessRoleId: roleId, run: "deployed",
        llmKeyId: anthropicKeyId, model: "claude-sonnet-5",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects a BYO deployment pinned to a model outside the key's provider catalog", async () => {
    const res = await app.request("/api/v1/agents/managed", {
      method: "POST", headers: auth(token),
      body: JSON.stringify({
        name: `byo-agent-bad-${S}`, accessRoleId: roleId, run: "deployed",
        llmKeyId: anthropicKeyId, model: "gpt-5.1",
      }),
    });
    expect(res.status).toBe(400);
  });
});
