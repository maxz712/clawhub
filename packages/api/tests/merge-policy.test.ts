import { describe, it, expect } from "vitest";
import { evaluateMerge, type MergePolicy } from "../src/services/merge-policy.js";

const base: MergePolicy = {
  requireHumanApproval: "if_risk_at_least",
  requireHumanApprovalLevel: "high",
  minApprovalsTotal: 1,
  minApprovalsHuman: 0,
  allowSelfReview: false,
  ciRequired: false,
  pathOverrides: [],
  trustedAgents: [],
};

describe("evaluateMerge", () => {
  it("blocks on request_changes", () => {
    const d = evaluateMerge({ policy: base, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "B", verdict: "request_changes" },
    ]});
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("changes_requested");
  });

  it("blocks on CI failure when ci_required", () => {
    const d = evaluateMerge({ policy: { ...base, ciRequired: true }, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "failure", reviews: [] });
    expect(d.mergeable).toBe(false);
    expect(d.needsCi).toBe(true);
  });

  it("requires human approval when risk >= threshold", () => {
    const d = evaluateMerge({ policy: base, risk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "B", verdict: "approve" },
    ]});
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("allows agent-only approval for low risk under threshold", () => {
    const d = evaluateMerge({ policy: base, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "B", verdict: "approve" },
    ]});
    expect(d.mergeable).toBe(true);
  });

  it("forces human review for path overrides", () => {
    const d = evaluateMerge({
      policy: { ...base, pathOverrides: [{ glob: "config/**", requireHuman: true }] },
      risk: "low", scope: ["config/app.yml"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "agent", reviewerId: "B", verdict: "approve" }],
    });
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("rejects self-approval unless allowSelfReview is set", () => {
    const d = evaluateMerge({ policy: base, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "A", verdict: "approve" },
    ]});
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_more_approvals");
  });
});
