import { describe, it, expect } from "vitest";
import { applyAutonomyDial, LOOP_CADENCES, LOOP_PRESETS, resolveLoopRoles } from "../src/services/loop.js";
import { normalizeMergePolicy } from "../src/services/merge-policy.js";
import { parseCron } from "../src/services/cron.js";

const base = normalizeMergePolicy({});

describe("LOOP_PRESETS (composable loop shapes)", () => {
  it("every preset enables at least one role", () => {
    for (const [name, roles] of Object.entries(LOOP_PRESETS)) {
      expect(Object.values(roles).some(Boolean), name).toBe(true);
    }
  });
  it("full = scout + developer + reviewer (files → builds → verifies → merges)", () => {
    expect(LOOP_PRESETS.full).toMatchObject({ scout: true, developer: true, reviewer: true });
  });
  it("the auto-merge shapes (full, dev-review) include a reviewer to attest", () => {
    expect(LOOP_PRESETS.full.reviewer).toBe(true);
    expect(LOOP_PRESETS["dev-review"].reviewer).toBe(true);
  });
  it("scout-dev has no reviewer (human reviews); single-role presets are exactly one role", () => {
    expect(LOOP_PRESETS["scout-dev"].reviewer).toBe(false);
    for (const p of ["scout", "dev", "review"] as const) {
      expect(Object.values(LOOP_PRESETS[p]).filter(Boolean).length, p).toBe(1);
    }
  });
});

describe("resolveLoopRoles (preset → role resolution)", () => {
  // The route ALWAYS sends includeScout/includeTriager as concrete booleans; a `false`
  // must NOT suppress a preset that turns the role on (the high-severity regression).
  it("preset 'full' with includeScout=false STILL deploys the scout (|| not ??)", () => {
    const r = resolveLoopRoles({ preset: "full", includeScout: false, includeTriager: false });
    expect(r).toEqual({ scout: true, developer: true, reviewer: true, triager: false });
  });
  it("preset 'scout' with includeScout=false STILL deploys the scout (doesn't collapse to zero roles)", () => {
    const r = resolveLoopRoles({ preset: "scout", includeScout: false });
    expect(r.scout).toBe(true);
    expect(r.developer || r.reviewer || r.triager).toBe(false);
  });
  it("no preset defaults to developer + reviewer (legacy bundle)", () => {
    expect(resolveLoopRoles({})).toEqual({ scout: false, developer: true, reviewer: true, triager: false });
  });
  it("includeScout=true force-adds a scout to a preset that lacks one", () => {
    expect(resolveLoopRoles({ preset: "dev-review", includeScout: true }).scout).toBe(true);
  });
  it("an explicit spec.enabled:false overrides the preset (opt a role OUT)", () => {
    expect(resolveLoopRoles({ preset: "full", scout: { enabled: false } }).scout).toBe(false);
  });
  it("a prototype-polluting preset name resolves to the safe default, not Object.prototype", () => {
    const r = resolveLoopRoles({ preset: "__proto__" as never });
    expect(r).toEqual({ scout: false, developer: true, reviewer: true, triager: false });
  });
});

describe("LOOP_CADENCES (work-cadence gating)", () => {
  it("every cadence is a valid 5-field UTC cron the scheduler can fire", () => {
    for (const [name, expr] of Object.entries(LOOP_CADENCES)) {
      expect(() => parseCron(expr), `${name}=${expr}`).not.toThrow();
    }
  });
  it("default 'daily' fires once a day (bounds the loop to one dev cycle/day)", () => {
    // 0 6 * * * — a single minute per day, not continuous.
    expect(LOOP_CADENCES.daily).toBe("0 6 * * *");
    const c = parseCron(LOOP_CADENCES.daily);
    expect([...c.minute]).toEqual([0]);
    expect([...c.hour]).toEqual([6]);
  });
  it("offers a higher-throughput opt-in (hourly) and a slower one (weekly)", () => {
    expect(LOOP_CADENCES.hourly).toBeDefined();
    expect(LOOP_CADENCES.weekly).toBeDefined();
  });
});

describe("applyAutonomyDial", () => {
  it("review_only leaves verified autonomy OFF", () => {
    const p = applyAutonomyDial(base, "review_only");
    expect(p.verifiedAutonomy).toBeUndefined();
    expect((p as Record<string, unknown>).autoMergeOnVerified).toBeFalsy();
  });

  it("low leaves verified autonomy OFF (earned autonomy covers low-risk self-merge)", () => {
    const p = applyAutonomyDial(base, "low");
    expect(p.verifiedAutonomy).toBeUndefined();
  });

  it("medium turns on verified autonomy at maxRisk medium with the RECOMMENDED floor + auto-merge", () => {
    const p = applyAutonomyDial(base, "medium");
    expect(p.verifiedAutonomy?.enabled).toBe(true);
    expect(p.verifiedAutonomy?.maxRisk).toBe("medium");
    expect(p.verifiedAutonomy?.allowSensitivePaths).toBe(false);
    expect(p.verifiedAutonomy?.floorGlobs?.length).toBeGreaterThan(0);
    expect(p.verifiedAutonomy?.maxInferredSpecRisk).toBe("low");
    expect((p as Record<string, unknown>).autoMergeOnVerified).toBe(true);
  });

  it("dialing medium then back to review_only clears the autonomy bits", () => {
    const medium = applyAutonomyDial(base, "medium");
    const reverted = applyAutonomyDial(medium, "review_only");
    expect(reverted.verifiedAutonomy).toBeUndefined();
    expect((reverted as Record<string, unknown>).autoMergeOnVerified).toBeFalsy();
  });
});
