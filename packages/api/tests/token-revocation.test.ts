import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signToken, hashToken, matchesHash } from "../src/services/auth.js";
import { verifyTokenCached, setRevocationChecker, _resetTokenCacheForTests } from "../src/services/token-cache.js";
import bcrypt from "bcryptjs";

describe("token hashing", () => {
  it("distinguishes two tokens for the same principal", async () => {
    // bcrypt truncates at 72 bytes — JWTs share their first 72 bytes (static
    // header + payload prefix), which made rotated tokens compare equal.
    // sha256 must not have that failure mode.
    const a = signToken({ kind: "agent", agentId: "00000000-0000-0000-0000-000000000001", name: "x" });
    await new Promise(r => setTimeout(r, 1100)); // different iat
    const b = signToken({ kind: "agent", agentId: "00000000-0000-0000-0000-000000000001", name: "x" });
    expect(a).not.toBe(b);
    const hashA = await hashToken(a);
    expect(await matchesHash(a, hashA)).toBe(true);
    expect(await matchesHash(b, hashA)).toBe(false);
  });

  it("still accepts legacy bcrypt hashes", async () => {
    const token = signToken({ kind: "agent", agentId: "00000000-0000-0000-0000-000000000002", name: "y" });
    const legacy = await bcrypt.hash(token, 8);
    expect(await matchesHash(token, legacy)).toBe(true);
  });
});

describe("revocation checker in the token cache", () => {
  beforeEach(() => _resetTokenCacheForTests());
  afterEach(() => _resetTokenCacheForTests());

  it("rejects tokens the checker disowns", async () => {
    setRevocationChecker(async () => false);
    const token = signToken({ kind: "user", userId: "u1", email: "a@b.c", v: 0 });
    await expect(verifyTokenCached(token)).rejects.toThrow();
  });

  it("passes tokens the checker accepts and caches the outcome", async () => {
    let calls = 0;
    setRevocationChecker(async () => { calls++; return true; });
    const token = signToken({ kind: "user", userId: "u2", email: "a@b.c", v: 3 });
    const p1 = await verifyTokenCached(token);
    const p2 = await verifyTokenCached(token);
    expect(p1.kind).toBe("user");
    expect(p2).toEqual(p1);
    expect(calls).toBe(1); // second hit served from cache
  });

  it("signature-only when no checker is set", async () => {
    const token = signToken({ kind: "agent", agentId: "a1", name: "n" });
    const p = await verifyTokenCached(token);
    expect(p.kind).toBe("agent");
  });
});
