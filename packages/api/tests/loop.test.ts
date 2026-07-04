import { describe, it, expect } from "vitest";
import { applyAutonomyDial, LOOP_CADENCES } from "../src/services/loop.js";
import { normalizeMergePolicy } from "../src/services/merge-policy.js";
import { parseCron } from "../src/services/cron.js";

const base = normalizeMergePolicy({});

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
