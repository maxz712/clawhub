import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { llmKeys, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { seal } from "../src/services/secrets.js";
import { EventBus } from "../src/services/events.js";
import { createAgentIdentityRoutes } from "../src/routes/agent-identity.js";
import { createWorkflowRoutes } from "../src/routes/workflows.js";
import { ensureDefaultAccessRoles } from "../src/services/access-roles.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// #75 — PATCH /agents/managed BYO model validation is skipped on deployment
// edit. #72 enforced "a pinned BYO model must be one of the key's own
// provider's selectable models" on CREATE (agent-identity.ts) but not on the
// PATCH /api/v1/standing-agents/:id edit path (routes/workflows.ts), so
// switching a deployment's key to a different provider while leaving a
// now-invalid model untouched was silently accepted.
const S = Date.now();
let app: Hono, token: string, anthropicKeyId: string, openaiKeyId: string, roleId: string;

describe.skipIf(!hasTestDb)("BYO model selection on edit (#75)", () => {
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `byoedit-${S}@t.co`, username: `byoeditu${S}`, passwordHash: "x" }).returning();
    token = signToken({ kind: "user", userId: u.id, email: u.email });

    const sealedAnthropic = seal("sk-ant-test-not-real");
    const [anthropicKey] = await db.insert(llmKeys).values({
      ownerUserId: u.id, name: "my claude key", provider: "anthropic",
      ciphertext: sealedAnthropic.ciphertext, nonce: sealedAnthropic.nonce,
    }).returning();
    anthropicKeyId = anthropicKey.id;

    const sealedOpenai = seal("sk-openai-test-not-real");
    const [openaiKey] = await db.insert(llmKeys).values({
      ownerUserId: u.id, name: "my openai key", provider: "openai",
      ciphertext: sealedOpenai.ciphertext, nonce: sealedOpenai.nonce,
    }).returning();
    openaiKeyId = openaiKey.id;

    const roles = await ensureDefaultAccessRoles(db, u.id);
    roleId = (roles.find(r => r.name === "Developer") ?? roles[0]).id;

    const events = new EventBus();
    const identity = createAgentIdentityRoutes(db, events);
    const workflows = createWorkflowRoutes(db, events);
    app = new Hono();
    app.route("/api/v1/llm-keys", identity.keys);
    app.route("/api/v1/agents", identity.managed);
    app.route("/api/v1/standing-agents", workflows.deployments);
    app.onError(errorHandler);
  });

  const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });

  async function deployWithKey(name: string, llmKeyId: string, model: string) {
    const res = await app.request("/api/v1/agents/managed", {
      method: "POST", headers: auth(token),
      body: JSON.stringify({ name, accessRoleId: roleId, run: "deployed", llmKeyId, model }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { deployed: Array<{ standingAgentId: string }> };
    return body.deployed[0].standingAgentId;
  }

  it("rejects switching the key to a different provider while keeping a now-invalid model", async () => {
    const saId = await deployWithKey(`byo-edit-bad-${S}`, anthropicKeyId, "claude-sonnet-5");
    const res = await app.request(`/api/v1/standing-agents/${saId}`, {
      method: "PATCH", headers: auth(token),
      body: JSON.stringify({ llmKeyId: openaiKeyId, model: "claude-sonnet-5" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts switching the key to a different provider with a compatible model", async () => {
    const saId = await deployWithKey(`byo-edit-ok-model-${S}`, anthropicKeyId, "claude-sonnet-5");
    const res = await app.request(`/api/v1/standing-agents/${saId}`, {
      method: "PATCH", headers: auth(token),
      body: JSON.stringify({ llmKeyId: openaiKeyId, model: "gpt-5.1" }),
    });
    expect(res.status).toBe(200);
  });

  it("accepts switching the key to a different provider with no model given", async () => {
    const saId = await deployWithKey(`byo-edit-ok-nomodel-${S}`, anthropicKeyId, "claude-sonnet-5");
    const res = await app.request(`/api/v1/standing-agents/${saId}`, {
      method: "PATCH", headers: auth(token),
      body: JSON.stringify({ llmKeyId: openaiKeyId }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects re-pinning an existing deployment's model to one outside its current key's provider", async () => {
    const saId = await deployWithKey(`byo-edit-samekey-bad-${S}`, anthropicKeyId, "claude-sonnet-5");
    const res = await app.request(`/api/v1/standing-agents/${saId}`, {
      method: "PATCH", headers: auth(token),
      body: JSON.stringify({ model: "gpt-5.1" }),
    });
    expect(res.status).toBe(400);
  });
});
