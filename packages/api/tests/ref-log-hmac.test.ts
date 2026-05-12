import { describe, it, expect } from "vitest";
import { signInternalBody, verifyInternalSignature } from "../src/services/ref-log.js";

describe("internal HMAC for ref-log endpoint", () => {
  const secret = "test-shared-secret";
  const body = '{"namespace":"ns","repo":"r","shardId":"s","updates":[]}';

  it("round-trips a signature", () => {
    const { timestamp, signature } = signInternalBody(body, secret);
    expect(verifyInternalSignature(body, secret, timestamp, signature)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const { timestamp, signature } = signInternalBody(body, secret);
    expect(verifyInternalSignature(body + "x", secret, timestamp, signature)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const { timestamp, signature } = signInternalBody(body, secret);
    expect(verifyInternalSignature(body, "other-secret", timestamp, signature)).toBe(false);
  });

  it("rejects a stale timestamp outside the tolerance window", () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const { signature } = signInternalBody(body, secret, Number(oldTs) * 1000);
    expect(verifyInternalSignature(body, secret, oldTs, signature, 60)).toBe(false);
  });

  it("rejects malformed timestamps", () => {
    expect(verifyInternalSignature(body, secret, "not-a-number", "ff", 60)).toBe(false);
  });
});
