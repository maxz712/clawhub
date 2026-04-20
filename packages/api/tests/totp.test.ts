import { describe, it, expect } from "vitest";
import { generateSecret, otpauthUrl, totpCode, verifyTotp } from "../src/services/totp.js";

describe("totp", () => {
  it("generates a base32 secret", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it("produces 6-digit codes", () => {
    const s = generateSecret();
    const code = totpCode(s);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("verifies the code it just produced", () => {
    const s = generateSecret();
    const now = Date.now();
    const code = totpCode(s, now);
    expect(verifyTotp(s, code, now)).toBe(true);
  });

  it("rejects wrong codes", () => {
    const s = generateSecret();
    expect(verifyTotp(s, "000000", Date.now())).toBe(false);
  });

  it("accepts codes within ±30s window", () => {
    const s = generateSecret();
    const now = Date.now();
    const prev = totpCode(s, now - 30_000);
    expect(verifyTotp(s, prev, now)).toBe(true);
  });

  it("builds an otpauth URL", () => {
    const u = otpauthUrl("alice@example.com", "ClawHub", "JBSWY3DPEHPK3PXP");
    expect(u.startsWith("otpauth://totp/")).toBe(true);
    expect(u).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(u).toContain("issuer=ClawHub");
  });
});
