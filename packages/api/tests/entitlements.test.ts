import { describe, it, expect } from "vitest";
import { TIERS, entitlementsFor, requireEntitlement } from "../src/services/entitlements.js";

describe("entitlements", () => {
  it("free grants public-only — no private repos / sso / standing agents", () => {
    expect(TIERS.free.privateRepos).toBe(false);
    expect(TIERS.free.sso).toBe(false);
    expect(TIERS.free.standingAgents).toBe(0);
  });

  it("team unlocks the paid features", () => {
    expect(TIERS.team.privateRepos).toBe(true);
    expect(TIERS.team.sso).toBe(true);
    expect(TIERS.team.branchProtection).toBe(true);
    expect(TIERS.team.standingAgents).toBeGreaterThan(0);
  });

  it("enterprise has unlimited standing agents", () => {
    expect(TIERS.enterprise.standingAgents).toBe(Infinity);
  });

  it("entitlementsFor falls back to free for an unknown plan", () => {
    // @ts-expect-error testing the fallback
    expect(entitlementsFor("bogus")).toEqual(TIERS.free);
  });

  it("requireEntitlement throws upgrade_required for a free plan", () => {
    expect(() => requireEntitlement("free", "sso")).toThrowError(/paid plan/);
    try { requireEntitlement("free", "privateRepos"); } catch (e) {
      expect((e as { code?: string }).code).toBe("upgrade_required");
      expect((e as { status?: number }).status).toBe(403);
    }
  });

  it("requireEntitlement passes for an entitled plan", () => {
    expect(() => requireEntitlement("team", "sso")).not.toThrow();
    expect(() => requireEntitlement("team", "privateRepos")).not.toThrow();
  });

  it("requireEntitlement treats a 0 cap as not-entitled", () => {
    expect(() => requireEntitlement("free", "standingAgents")).toThrow();
    expect(() => requireEntitlement("team", "standingAgents")).not.toThrow();
  });
});
