import { describe, it, expect } from "vitest";
import { generateSecret, totpCode, verifyTotpStep, sealTotpSecret, openTotpSecret, verifyAndConsumeTotp } from "../src/services/totp.js";

// Audit follow-up: TOTP codes must be single-use within their window (replay
// guard) and the secret roundtrips through seal/open.

// Minimal fake DB that records the totpLastStep written by verifyAndConsumeTotp.
function fakeDb() {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    writes,
    update() { return { set(v: Record<string, unknown>) { writes.push(v); return { where() { return Promise.resolve(); } }; } }; },
  };
  return db as unknown as Parameters<typeof verifyAndConsumeTotp>[0] & { writes: typeof writes };
}

describe("TOTP seal/open roundtrip", () => {
  it("opens what it sealed (sealed or plaintext-fallback)", () => {
    const secret = generateSecret();
    const { secret: stored, nonce } = sealTotpSecret(secret);
    expect(openTotpSecret(stored, nonce)).toBe(secret);
  });
});

describe("verifyTotpStep", () => {
  it("returns a monotonic step for a valid code and null for a wrong one", () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const step = verifyTotpStep(secret, totpCode(secret, at), at);
    expect(step).not.toBeNull();
    expect(verifyTotpStep(secret, "000000", at)).toBeNull();
    // A code one window later resolves to a strictly greater step.
    const later = verifyTotpStep(secret, totpCode(secret, at + 30_000), at + 30_000);
    expect(later!).toBeGreaterThan(step!);
  });
});

describe("verifyAndConsumeTotp (single-use replay guard)", () => {
  it("accepts a code once, then rejects the same code as a replay", async () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, at);
    const db = fakeDb();
    const user = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null as number | null };

    // First use: accepted, and a last-step is persisted.
    expect(await verifyAndConsumeTotp(db, user, code, at)).toBe(true);
    expect(db.writes.length).toBe(1);
    const consumedStep = db.writes[0].totpLastStep as number;

    // Simulate persistence, then replay the SAME code → rejected.
    user.totpLastStep = consumedStep;
    expect(await verifyAndConsumeTotp(db, user, code, at)).toBe(false);
  });

  it("rejects an invalid code without consuming", async () => {
    const secret = generateSecret();
    const db = fakeDb();
    const user = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
    expect(await verifyAndConsumeTotp(db, user, "000000", 1_700_000_000_000)).toBe(false);
    expect(db.writes.length).toBe(0);
  });
});
