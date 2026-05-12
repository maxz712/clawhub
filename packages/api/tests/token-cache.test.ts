import { describe, it, expect, beforeEach, vi } from "vitest";
import { signToken } from "../src/services/auth.js";
import * as authMod from "../src/services/auth.js";
import { _resetTokenCacheForTests, verifyTokenCached } from "../src/services/token-cache.js";

describe("verifyTokenCached", () => {
  beforeEach(() => _resetTokenCacheForTests());

  it("returns the same payload as verifyToken on miss", async () => {
    const tok = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const p = await verifyTokenCached(tok);
    expect(p.kind).toBe("agent");
    if (p.kind === "agent") expect(p.agentId).toBe("a1");
  });

  it("hits the local in-process cache on a second call within 5s", async () => {
    const tok = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    await verifyTokenCached(tok);
    const spy = vi.spyOn(authMod, "verifyToken");
    const p2 = await verifyTokenCached(tok);
    expect(p2.kind).toBe("agent");
    // Local cache hit means verifyToken should not be re-invoked.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("throws on invalid tokens just like verifyToken", async () => {
    await expect(verifyTokenCached("not-a-token")).rejects.toBeDefined();
  });
});
