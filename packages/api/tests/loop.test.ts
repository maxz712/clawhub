import { describe, it, expect } from "vitest";
import { applyAutonomyDial, LOOP_CADENCES, LOOP_PRESETS, resolveLoopRoles } from "../src/services/loop.js";
import { evaluateMerge, normalizeMergePolicy, type MergeInputs } from "../src/services/merge-policy.js";
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

  it("low leaves verified autonomy + hands-off auto-merge OFF (that is what medium buys)", () => {
    const p = applyAutonomyDial(base, "low");
    expect(p.verifiedAutonomy).toBeUndefined();
    expect((p as Record<string, unknown>).autoMergeOnVerified).toBeFalsy();
  });

  // #136: `low` shared the review_only branch and leaned on earned autonomy, which
  // v3 retired from the merge gate — so the two dials wrote byte-identical policy
  // and `low` was a silent no-op. This is the contract that would have caught it.
  it("low is OBSERVABLY different from review_only (it is not a silent no-op)", () => {
    const low = applyAutonomyDial(base, "low");
    const reviewOnly = applyAutonomyDial(base, "review_only");
    expect(low).not.toEqual(reviewOnly);
    expect(low.allowSelfReview).toBe(true);
    expect(reviewOnly.allowSelfReview).toBe(false);
  });

  it("low keeps the production backstops: sensitive baseline ON, code review at high", () => {
    const p = applyAutonomyDial(base, "low");
    expect(p.sensitiveBaseline).not.toBe(false);
    expect(p.codeReviewRequiredAtRisk).toBe("high");
    expect(p.requireHumanApproval).toBe("if_risk_at_least");
    expect(p.requireHumanApprovalLevel).toBe("medium");
  });

  it("low never LOWERS a stricter minApprovalsTotal", () => {
    const strict = normalizeMergePolicy({ minApprovalsTotal: 2 });
    expect(applyAutonomyDial(strict, "low").minApprovalsTotal).toBe(2);
    expect(applyAutonomyDial(base, "low").minApprovalsTotal).toBe(1);
  });

  it("dialing low then back to review_only revokes self-review (uninstall really reverts)", () => {
    const low = applyAutonomyDial(base, "low");
    expect(applyAutonomyDial(low, "review_only").allowSelfReview).toBe(false);
  });
});

// The dial's contract is what `evaluateMerge` DOES with the policy it writes —
// asserting the object shape alone is how #136 survived (the shape was "valid",
// it just meant nothing). Drive the real gate with a Loop developer's Change.
describe("applyAutonomyDial('low') through the merge gate", () => {
  const DEV_AGENT = "loop-developer-agent-id";
  const policy = applyAutonomyDial(base, "low");

  // A Change the Loop's developer opened and approved itself — the whole point of
  // the dial. No human review exists anywhere in these inputs.
  const change = (over: Partial<MergeInputs> = {}): MergeInputs => ({
    policy,
    risk: "low",
    scope: ["packages/api/src/services/foo.ts"],
    changedPaths: ["packages/api/src/services/foo.ts"],
    openedByAgentId: DEV_AGENT,
    namespaceType: "user",
    reviews: [{ reviewerKind: "agent", reviewerId: DEV_AGENT, verdict: "approve", basis: "code" }],
    ciStatus: "success",
    ...over,
  });

  it("a LOW-risk self-approved Change merges with no human", () => {
    const d = evaluateMerge(change());
    expect(d.mergeable).toBe(true);
    expect(d.needsHuman).toBe(false);
  });

  it("the SAME Change under review_only still waits for a human", () => {
    const d = evaluateMerge(change({ policy: applyAutonomyDial(base, "review_only") }));
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_more_approvals");
  });

  it("a MEDIUM-risk Change is still blocked on a human approval", () => {
    const d = evaluateMerge(change({ risk: "medium" }));
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_human_approval");
    expect(d.needsHuman).toBe(true);
  });

  it("server-COMPUTED medium risk blocks too (an agent can't declare its way to low)", () => {
    const d = evaluateMerge(change({ risk: "low", computedRisk: "medium" }));
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("a SENSITIVE-path Change (a migration) still needs a human code review", () => {
    const d = evaluateMerge(change({
      scope: ["packages/api/drizzle/0099_x.sql"],
      changedPaths: ["packages/api/drizzle/0099_x.sql"],
    }));
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
    // The sensitive baseline forces a CODE-level human approval; with no human
    // approval at all the gate reports the outer failure ("no human approved"),
    // and flags that the missing approval had to be code-level.
    expect(d.reason).toBe("needs_human_approval");
    expect(d.codeReviewRequired).toBe(true);
  });

  it("a sensitive-path Change is NOT satisfied by a behavior-only human approval either", () => {
    const d = evaluateMerge(change({
      scope: ["packages/api/drizzle/0099_x.sql"],
      changedPaths: ["packages/api/drizzle/0099_x.sql"],
      reviews: [
        { reviewerKind: "agent", reviewerId: DEV_AGENT, verdict: "approve", basis: "code" },
        { reviewerKind: "human", reviewerId: "human-1", verdict: "approve", basis: "behavior" },
      ],
    }));
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
  });

  it("failing CI still blocks a low-risk self-merge", () => {
    const d = evaluateMerge(change({ ciStatus: "failure" }));
    expect(d.mergeable).toBe(false);
    expect(d.needsCi).toBe(true);
  });

  it("a request_changes verdict still blocks it", () => {
    const d = evaluateMerge(change({
      reviews: [
        { reviewerKind: "agent", reviewerId: DEV_AGENT, verdict: "approve", basis: "code" },
        { reviewerKind: "human", reviewerId: "human-1", verdict: "request_changes" },
      ],
    }));
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("changes_requested");
  });

  it("with NO review at all it does not merge — self-review counts, absence doesn't", () => {
    const d = evaluateMerge(change({ reviews: [] }));
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_more_approvals");
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
