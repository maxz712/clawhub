import { describe, it, expect } from "vitest";
import { validateVerifyPlan, isLocalTarget, hashPaths, hashSpec, isPlanStale } from "../src/services/verify-plan.js";

describe("isLocalTarget", () => {
  it("accepts relative paths and localhost URLs", () => {
    expect(isLocalTarget("/dashboard")).toBe(true);
    expect(isLocalTarget("http://localhost:3001/x")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1:3000")).toBe(true);
  });
  it("rejects external hosts and protocol-relative URLs", () => {
    expect(isLocalTarget("https://evil.com/steal")).toBe(false);
    expect(isLocalTarget("//evil.com")).toBe(false);
    expect(isLocalTarget("file:///etc/passwd")).toBe(false);
    expect(isLocalTarget("")).toBe(false);
    expect(isLocalTarget(42)).toBe(false);
  });
});

describe("validateVerifyPlan", () => {
  it("accepts a whitelisted plan with local navigation", () => {
    const r = validateVerifyPlan([
      { type: "goto", url: "/login" },
      { type: "fill", selector: "#email", value: "x" },
      { type: "click", selector: "button" },
      { type: "snapshot" },
      { type: "expectVisible", selector: ".feed" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toHaveLength(5);
  });
  it("rejects an unknown step type", () => {
    const r = validateVerifyPlan([{ type: "exfiltrate", url: "/x" }]);
    expect(r.ok).toBe(false);
  });
  it("rejects a goto to an external host (attack guard)", () => {
    const r = validateVerifyPlan([{ type: "goto", url: "https://evil.com" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/relative path or localhost/);
  });
  it("rejects an apiCheck to an external host", () => {
    const r = validateVerifyPlan([{ type: "apiCheck", url: "https://evil.com/api" }]);
    expect(r.ok).toBe(false);
  });
  it("rejects an empty plan", () => {
    expect(validateVerifyPlan([]).ok).toBe(false);
  });
});

describe("isPlanStale", () => {
  const base = { changedPathsHash: "p", specHash: "s", tier: "app", failureCount: 0 };
  const cur = { changedPathsHash: "p", specHash: "s", tier: "app" };
  it("fresh when all anchors match and no failures", () => {
    expect(isPlanStale(base, cur)).toBe(false);
  });
  it("stale when the changed paths shift", () => {
    expect(isPlanStale(base, { ...cur, changedPathsHash: "other" })).toBe(true);
  });
  it("stale when the spec shifts", () => {
    expect(isPlanStale(base, { ...cur, specHash: "other" })).toBe(true);
  });
  it("stale when the tier changes", () => {
    expect(isPlanStale(base, { ...cur, tier: "dind" })).toBe(true);
  });
  it("stale after 2 consecutive playback failures", () => {
    expect(isPlanStale({ ...base, failureCount: 2 }, cur)).toBe(true);
  });
});

describe("hashPaths / hashSpec", () => {
  it("is order-independent for paths and stable", () => {
    expect(hashPaths(["a", "b"])).toBe(hashPaths(["b", "a"]));
    expect(hashPaths(["a"])).not.toBe(hashPaths(["b"]));
  });
  it("hashSpec is stable and differs on content", () => {
    expect(hashSpec("x")).toBe(hashSpec("x"));
    expect(hashSpec("x")).not.toBe(hashSpec("y"));
  });
});
