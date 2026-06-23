import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { signToken } from "../src/services/auth.js";
import { authenticateGitRequest } from "../src/middleware/auth.js";

function mkCtx(authHeader: string | undefined) {
  const app = new Hono();
  let result: ReturnType<typeof authenticateGitRequest> | undefined;
  app.get("/probe", c => { result = authenticateGitRequest(c); return c.text("ok"); });
  return async () => {
    const headers: Record<string, string> = {};
    if (authHeader) headers["authorization"] = authHeader;
    await app.request("/probe", { headers });
    return result!;
  };
}

describe("authenticateGitRequest", () => {
  it("returns none when no auth", async () => {
    const r = await mkCtx(undefined)();
    expect(r.kind).toBe("none");
  });

  // Humans are now first-class pushers: a USER token authenticates a human push.
  // The username is informational; the JWT decides the identity.
  it("accepts user tokens (humans push as themselves)", async () => {
    const userToken = signToken({ kind: "user", userId: "u1", email: "e@x" });
    const basic = Buffer.from(`alice:${userToken}`).toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("user");
    expect(r.userId).toBe("u1");
    // The provided handle is surfaced for display + the merge-commit author line.
    expect(r.userName).toBe("alice");
  });

  it("accepts a user token even under the agent-token username (handle falls back to email)", async () => {
    const userToken = signToken({ kind: "user", userId: "u2", email: "e2@x" });
    const basic = Buffer.from(`agent-token:${userToken}`).toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("user");
    expect(r.userId).toBe("u2");
    expect(r.userName).toBe("e2@x");
  });

  it("accepts agent tokens regardless of the basic username", async () => {
    const agentToken = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    for (const user of ["agent-token", "bob"]) {
      const basic = Buffer.from(`${user}:${agentToken}`).toString("base64");
      const r = await mkCtx(`Basic ${basic}`)();
      expect(r.kind).toBe("agent");
      expect(r.agentId).toBe("a1");
      expect(r.agentName).toBe("bot");
    }
  });

  it("rejects a malformed/garbage token", async () => {
    const basic = Buffer.from("agent-token:not-a-jwt").toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("rejected");
    expect(r.reason).toBe("invalid_token");
  });
});
