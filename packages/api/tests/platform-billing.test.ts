import { describe, it, expect } from "vitest";
import { decideBudget, REVIEW_OVERAGE_MICRO_USD, VERIFY_RUN_MICRO_USD } from "../src/services/platform-billing.js";
import { entitlementsFor, TIERS } from "../src/services/entitlements.js";

describe("decideBudget", () => {
  it("proceeds with no cap", () => {
    expect(decideBudget(999, 0, "block", 80).mode).toBe("proceed");
  });
  it("proceeds under the cap", () => {
    expect(decideBudget(50, 100, "block", 80).mode).toBe("proceed");
  });
  it("applies the configured onExhaust at/over the cap", () => {
    expect(decideBudget(100, 100, "block", 80).mode).toBe("block");
    expect(decideBudget(120, 100, "byo_fallback", 80).mode).toBe("byo_fallback");
    expect(decideBudget(120, 100, "queue", 80).mode).toBe("queue");
  });
  it("raises the alert flag at the threshold", () => {
    expect(decideBudget(79, 100, "block", 80).alert).toBe(false);
    expect(decideBudget(80, 100, "block", 80).alert).toBe(true);
  });
});

describe("SKU prices (D1)", () => {
  it("review overage is $0.10 and verify is $2.00 (micro-USD)", () => {
    expect(REVIEW_OVERAGE_MICRO_USD).toBe(100_000);
    expect(VERIFY_RUN_MICRO_USD).toBe(2_000_000);
  });
});

describe("pro tier entitlements (M7)", () => {
  it("pro grants a 500-review pool + 10 verify credits", () => {
    const pro = entitlementsFor("pro");
    expect(pro.platformReviews).toBe(500);
    expect(pro.verifyCredits).toBe(10);
    expect(pro.privateRepos).toBe(true);
  });
  it("free grants 50 reviews and no verify credits", () => {
    expect(TIERS.free.platformReviews).toBe(50);
    expect(TIERS.free.verifyCredits).toBe(0);
  });
  it("enterprise is unmetered (Infinity pools)", () => {
    expect(TIERS.enterprise.platformReviews).toBe(Infinity);
    expect(TIERS.enterprise.verifyCredits).toBe(Infinity);
  });
});
