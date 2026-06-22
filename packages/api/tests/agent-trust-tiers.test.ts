import { describe, it, expect } from "vitest";
import {
  AUTO_PROMOTE_CEILING_TIER,
  MIN_AUTONOMY_TIER,
  MIN_AUTO_PROMOTE_CASES,
  tierRank,
} from "../src/services/trust-tiers.js";
import { autoPromotionTarget } from "../src/services/agent-versions.js";

// The load-bearing invariant: a SELF-REPORTED eval can promote a version at most
// to the ceiling, and the ceiling must sit strictly BELOW the tier that confers
// earned-autonomy self-merge — otherwise an agent reporting all-pass could
// self-grant merge authority. If this fails, the anti-gaming design is defeated.
describe("trust-tier anti-gaming invariant", () => {
  it("auto-promote ceiling sits strictly below the autonomy floor", () => {
    expect(tierRank(AUTO_PROMOTE_CEILING_TIER)).toBeLessThan(tierRank(MIN_AUTONOMY_TIER));
  });

  it("ranks order untrusted < sandbox < standard < trusted", () => {
    expect(tierRank("untrusted")).toBeLessThan(tierRank("sandbox"));
    expect(tierRank("sandbox")).toBeLessThan(tierRank("standard"));
    expect(tierRank("standard")).toBeLessThan(tierRank("trusted"));
    expect(tierRank("nonsense")).toBe(-1);
  });
});

describe("autoPromotionTarget (eval anti-gaming ceiling)", () => {
  const ok = { score: 100, passingThreshold: 80, suiteCaseCount: MIN_AUTO_PROMOTE_CASES, resultCount: MIN_AUTO_PROMOTE_CASES };

  it("promotes untrusted → sandbox on a passing, rigorous run", () => {
    expect(autoPromotionTarget({ currentTier: "untrusted", ...ok })).toBe("sandbox");
  });

  it("CANNOT auto-promote sandbox → standard (the autonomy-conferring tier needs a human)", () => {
    expect(autoPromotionTarget({ currentTier: "sandbox", ...ok })).toBeNull();
  });

  it("CANNOT auto-promote standard or trusted further", () => {
    expect(autoPromotionTarget({ currentTier: "standard", ...ok })).toBeNull();
    expect(autoPromotionTarget({ currentTier: "trusted", ...ok })).toBeNull();
  });

  it("does not promote when the self-reported score is below threshold", () => {
    expect(autoPromotionTarget({ currentTier: "untrusted", ...ok, score: 79 })).toBeNull();
  });

  it("does not promote a trivial suite (fewer than the minimum cases)", () => {
    expect(autoPromotionTarget({ currentTier: "untrusted", ...ok, suiteCaseCount: MIN_AUTO_PROMOTE_CASES - 1, resultCount: MIN_AUTO_PROMOTE_CASES - 1 })).toBeNull();
  });

  it("does not promote when the run cherry-picked a subset of cases", () => {
    expect(autoPromotionTarget({ currentTier: "untrusted", ...ok, suiteCaseCount: 5, resultCount: 3 })).toBeNull();
  });
});
