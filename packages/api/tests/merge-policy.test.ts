import { describe, it, expect } from "vitest";
import { applySoloModePreset, evaluateMerge, touchesBaselineSensitive, type MergePolicy } from "../src/services/merge-policy.js";

// Explicit policy so these tests never silently drift when the schema default
// changes. codeReviewRequiredAtRisk defaults to "high" but we set it for clarity.
const base: MergePolicy = {
  requireHumanApproval: "if_risk_at_least",
  requireHumanApprovalLevel: "high",
  minApprovalsTotal: 1,
  minApprovalsHuman: 0,
  allowSelfReview: false,
  ciRequired: false,
  codeReviewRequiredAtRisk: "high",
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

  // A trusted agent's approval substitutes for a general approval on low risk.
  // This is the contract org-registry `trusted`-tier enrollment relies on:
  // changes.ts merges those agent names into policy.trustedAgents for org repos.
  it("counts a trusted agent's low-risk approval toward minApprovalsTotal", () => {
    const policy: MergePolicy = { ...base, minApprovalsTotal: 2, allowSelfReview: true, trustedAgents: ["reviewer-bot"] };
    const reviews = [{ reviewerKind: "agent" as const, reviewerId: "B", agentName: "reviewer-bot", verdict: "approve" as const }];
    // Trusted on low risk: the one approval is double-counted, reaching 2.
    expect(evaluateMerge({ policy, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews }).mergeable).toBe(true);
    // Same approval, agent NOT in trustedAgents → only 1 effective → blocked.
    const untrusted = evaluateMerge({ policy: { ...policy, trustedAgents: [] }, risk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews });
    expect(untrusted.mergeable).toBe(false);
    expect(untrusted.reason).toBe("needs_more_approvals");
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

  // --- Review basis + code-review gate ---

  it("accepts a behavior-basis human approval at medium risk", () => {
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "medium", minApprovalsHuman: 1 };
    const d = evaluateMerge({ policy, risk: "medium", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" },
    ]});
    expect(d.mergeable).toBe(true);
  });

  it("blocks at high risk with needs_code_review when the only human approval is behavior-only", () => {
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 1 };
    const d = evaluateMerge({ policy, risk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" },
    ]});
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
    expect(d.needsHuman).toBe(true);
  });

  it("accepts a code-basis human approval at high risk", () => {
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 1 };
    const d = evaluateMerge({ policy, risk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" },
    ]});
    expect(d.mergeable).toBe(true);
  });

  it("accepts a both-basis human approval at high risk", () => {
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 1 };
    const d = evaluateMerge({ policy, risk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "both" },
    ]});
    expect(d.mergeable).toBe(true);
  });

  it("a path override forces code-level review even at low risk", () => {
    const policy: MergePolicy = { ...base, pathOverrides: [{ glob: "**/*.sql", requireHuman: true }] };
    const behavior = evaluateMerge({ policy, risk: "low", scope: ["db/x.sql"], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" },
    ]});
    expect(behavior.mergeable).toBe(false);
    expect(behavior.reason).toBe("needs_code_review");

    const code = evaluateMerge({ policy, risk: "low", scope: ["db/x.sql"], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" },
    ]});
    expect(code.mergeable).toBe(true);
  });

  // --- computedRisk overrides a lower declared risk ---

  it("uses computedRisk when it exceeds declared risk", () => {
    // Declared low, computed high → must require a human code-level approval.
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 1 };
    const blocked = evaluateMerge({ policy, risk: "low", computedRisk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "B", verdict: "approve", basis: "code" },
    ]});
    expect(blocked.mergeable).toBe(false);
    expect(blocked.needsHuman).toBe(true);

    const ok = evaluateMerge({ policy, risk: "low", computedRisk: "high", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" },
    ]});
    expect(ok.mergeable).toBe(true);
  });

  it("ignores computedRisk when it is lower than declared", () => {
    const policy: MergePolicy = { ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 1 };
    const d = evaluateMerge({ policy, risk: "high", computedRisk: "low", scope: [], openedByAgentId: "A", ciStatus: "success", reviews: [
      { reviewerKind: "agent", reviewerId: "B", verdict: "approve", basis: "code" },
    ]});
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  // Regression: a sensitive path in the REAL diff forces a human code review
  // even when the agent's declared scope hides it. Gating reads changedPaths.
  it("path forcing uses authoritative changedPaths, not the agent's scope trailer", () => {
    const policy: MergePolicy = { ...base, pathOverrides: [{ glob: "deploy/**", requireHuman: true }] };
    const spoofed = evaluateMerge({
      policy, risk: "low",
      scope: ["src/util.ts"],                   // agent under-reports
      changedPaths: ["deploy/k8s/deploy.yaml"], // git's authoritative truth
      openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "H", verdict: "approve", basis: "behavior" }],
    });
    expect(spoofed.mergeable).toBe(false);
    expect(spoofed.reason).toBe("needs_code_review");
  });

  it("falls back to scope for path forcing only when changedPaths is absent", () => {
    const policy: MergePolicy = { ...base, pathOverrides: [{ glob: "deploy/**", requireHuman: true }] };
    const d = evaluateMerge({
      policy, risk: "low", scope: ["deploy/k8s/deploy.yaml"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "H", verdict: "approve", basis: "behavior" }],
    });
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
  });
});

// --- Solo mode preset: a team of one can ship their own low/medium work, but
// the sensitive-path + high-risk code-review backstops stay on. ---
describe("applySoloModePreset", () => {
  const teamDefault: MergePolicy = {
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "medium",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: false,
    ciRequired: true,
    codeReviewRequiredAtRisk: "high",
    pathOverrides: [{ glob: "**/*.sql", requireHuman: true }],
    trustedAgents: [],
    allowedMergeMethods: ["merge", "squash", "rebase"],
    defaultMergeMethod: "squash",
  };

  it("flips the self-merge fields without clobbering preserved settings", () => {
    const solo = applySoloModePreset(teamDefault);
    expect(solo.allowSelfReview).toBe(true);
    expect(solo.minApprovalsTotal).toBe(1);
    expect(solo.requireHumanApprovalLevel).toBe("high");
    expect(solo.codeReviewRequiredAtRisk).toBe("high");
    // Preserved: existing path overrides, merge methods, CI requirement.
    expect(solo.pathOverrides).toEqual(teamDefault.pathOverrides);
    expect(solo.defaultMergeMethod).toBe("squash");
    expect(solo.ciRequired).toBe(true);
  });

  it("lets a solo developer self-approve their own low-risk change", () => {
    const policy = applySoloModePreset(teamDefault);
    const d = evaluateMerge({
      policy, risk: "low", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" }],
    });
    expect(d.mergeable).toBe(true);
  });

  it("keeps the sensitive-path human code-review backstop in solo mode", () => {
    const policy = applySoloModePreset(teamDefault);
    const d = evaluateMerge({
      policy, risk: "low", scope: ["db/migrate.sql"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" }],
    });
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
  });

  it("keeps the high-risk code-review backstop in solo mode", () => {
    const policy = applySoloModePreset(teamDefault);
    const d = evaluateMerge({
      policy, risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" }],
    });
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
  });
});

describe("BASELINE_SENSITIVE_GLOBS — non-removable deploy/CI/schema floor", () => {
  // Deliberately permissive: empty pathOverrides + thresholds pushed to critical
  // so ONLY the non-removable baseline can force a human. Proves a repo can't
  // configure deploy/CI/schema paths out of human code review.
  const permissive: MergePolicy = {
    ...base, requireHumanApprovalLevel: "critical", codeReviewRequiredAtRisk: "critical", pathOverrides: [],
  };

  for (const p of ["scripts/self-deploy.sh", ".clawhub/ci/deploy.yml", "packages/api/migrations/0099_x.sql", "deploy/helm/values.yaml", "Dockerfile", "docker-compose.yml"]) {
    it(`forces a human on ${p} at low risk under a permissive policy`, () => {
      const d = evaluateMerge({
        policy: permissive, risk: "low", scope: [p], changedPaths: [p], openedByAgentId: "A", ciStatus: "success",
        reviews: [{ reviewerKind: "agent", reviewerId: "B", verdict: "approve" }],
      });
      expect(d.mergeable).toBe(false);
      expect(d.needsHuman).toBe(true);
    });
  }

  it("a behavior-only human approval is not enough for scripts/** — needs code review", () => {
    const d = evaluateMerge({
      policy: permissive, risk: "low", scope: [], changedPaths: ["scripts/self-deploy.sh"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "behavior" }],
    });
    expect(d.mergeable).toBe(false);
    expect(d.reason).toBe("needs_code_review");
  });

  it("a code-basis human approval CAN merge a deploy-script change (legit self-deploy flow preserved)", () => {
    const d = evaluateMerge({
      policy: { ...permissive, minApprovalsTotal: 1 }, risk: "low", scope: [], changedPaths: ["scripts/self-deploy.sh"], openedByAgentId: "A", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" }],
    });
    expect(d.mergeable).toBe(true);
  });

  it("touchesBaselineSensitive matches deploy/CI/schema paths, not ordinary app code", () => {
    expect(touchesBaselineSensitive(["scripts/x.sh"])).toBe(true);
    expect(touchesBaselineSensitive([".clawhub/ci/p.yml"])).toBe(true);
    expect(touchesBaselineSensitive(["packages/api/migrations/0001.sql"])).toBe(true);
    expect(touchesBaselineSensitive(["src/app.ts", "README.md"])).toBe(false);
  });
});
