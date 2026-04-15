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

  it("rejects user tokens outright (humans-do-not-push)", async () => {
    const userToken = signToken({ kind: "user", userId: "u1", email: "e@x" });
    const basic = Buffer.from(`agent-token:${userToken}`).toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("rejected");
    expect(r.reason).toBe("humans-do-not-push");
  });

  it("rejects wrong basic username", async () => {
    const agentToken = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const basic = Buffer.from(`bob:${agentToken}`).toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("rejected");
    expect(r.reason).toBe("humans-do-not-push");
  });

  it("accepts agent tokens under agent-token username", async () => {
    const agentToken = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const basic = Buffer.from(`agent-token:${agentToken}`).toString("base64");
    const r = await mkCtx(`Basic ${basic}`)();
    expect(r.kind).toBe("agent");
    expect(r.agentId).toBe("a1");
    expect(r.agentName).toBe("bot");
  });
});
