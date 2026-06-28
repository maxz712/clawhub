import { describe, it, expect } from "vitest";
import { applySoloModePreset, evaluateMerge, normalizeMergePolicy, touchesBaselineSensitive, type MergePolicy } from "../src/services/merge-policy.js";

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

describe("normalizeMergePolicy (Batch 9 — org-default / per-repo write-path hardening)", () => {
  it("coerces a partial/empty policy to a complete, SAFE policy (no bricking, no weakened gates)", () => {
    const p = normalizeMergePolicy({});
    // Safe defaults: CI required, human approval if_risk_at_least medium, no self-review.
    expect(p.ciRequired).toBe(true);
    expect(p.requireHumanApproval).toBe("if_risk_at_least");
    expect(p.requireHumanApprovalLevel).toBe("medium");
    expect(p.allowSelfReview).toBe(false);
    expect(p.codeReviewRequiredAtRisk).toBe("high");
    expect(Array.isArray(p.pathOverrides)).toBe(true);
    expect(Array.isArray(p.trustedAgents)).toBe(true);
  });

  it("rejects garbage field values, falling back to safe defaults", () => {
    const p = normalizeMergePolicy({ requireHumanApproval: "lol", requireHumanApprovalLevel: "banana", ciRequired: "yes", minApprovalsTotal: -3, minApprovalsHuman: "x", pathOverrides: "nope", trustedAgents: [1, "ok", null] });
    expect(p.requireHumanApproval).toBe("if_risk_at_least");
    expect(p.requireHumanApprovalLevel).toBe("medium");
    expect(p.ciRequired).toBe(true);            // non-bool → safe default true
    expect(p.minApprovalsTotal).toBe(1);        // negative → default
    expect(p.minApprovalsHuman).toBe(0);        // non-number → default
    expect(p.pathOverrides).toEqual([]);        // non-array → []
    expect(p.trustedAgents).toEqual(["ok"]);    // non-strings filtered out
  });

  it("preserves valid values + well-formed pathOverrides", () => {
    const p = normalizeMergePolicy({ requireHumanApproval: "always", requireHumanApprovalLevel: "critical", ciRequired: false, minApprovalsTotal: 2, minApprovalsHuman: 1, allowSelfReview: true, pathOverrides: [{ glob: "src/**", requireHuman: true }, { glob: 123 }], trustedAgents: ["bot-a"], requireIndependentApprover: true });
    expect(p.requireHumanApproval).toBe("always");
    expect(p.requireHumanApprovalLevel).toBe("critical");
    expect(p.ciRequired).toBe(false);
    expect(p.minApprovalsTotal).toBe(2);
    expect(p.allowSelfReview).toBe(true);
    expect(p.pathOverrides).toEqual([{ glob: "src/**", requireHuman: true }]); // bad entry dropped
    expect(p.requireIndependentApprover).toBe(true);
  });

  it("a malformed persisted policy still EVALUATES (does not throw) and keeps the sensitive-path + CI gates", () => {
    // The exact bricking scenario: an org admin PUTs `{}` → seeded into a repo's
    // mergePolicy → a Change must still evaluate. evaluateMerge normalizes
    // internally, so pathOverrides.some(...) can't throw and CI stays required.
    const malformed = {} as unknown as MergePolicy;
    const d = evaluateMerge({ policy: malformed, risk: "low", scope: [], changedPaths: ["deploy/prod.yml"], openedByAgentId: "A", ciStatus: "success", reviews: [] });
    // Sensitive baseline path forces a human code review regardless of policy.
    expect(d.needsHuman).toBe(true);
    expect(d.codeReviewRequired).toBe(true);
    expect(d.mergeable).toBe(false);
    // And CI is required (default true) — a failing CI blocks.
    const d2 = evaluateMerge({ policy: malformed, risk: "low", scope: [], changedPaths: ["README.md"], openedByAgentId: "A", ciStatus: "failure", reviews: [] });
    expect(d2.needsCi).toBe(true);
    expect(d2.mergeable).toBe(false);
  });
});

// Humans are first-class authors: a Change can be opened by a USER (openedByUserId)
// instead of an agent. The merge gate treats them symmetrically — the author's
// own approval is excluded unless allowSelfReview, and on org repos the human
// author can't be their own independent reviewer.
describe("evaluateMerge — human-authored changes", () => {
  it("a human author cannot self-approve their own change unless allowSelfReview", () => {
    // Human U opened it and is the only approver → excluded → no approvals.
    const blocked = evaluateMerge({ policy: base, risk: "low", scope: [], openedByUserId: "U", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve" },
    ]});
    expect(blocked.mergeable).toBe(false);
    expect(blocked.reason).toBe("needs_more_approvals");
    // With allowSelfReview, the human's own approval counts (solo flow).
    const allowed = evaluateMerge({ policy: { ...base, allowSelfReview: true }, risk: "low", scope: [], openedByUserId: "U", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "U", verdict: "approve" },
    ]});
    expect(allowed.mergeable).toBe(true);
  });

  it("a low-risk human change merges with an independent approval", () => {
    const d = evaluateMerge({ policy: base, risk: "low", scope: [], openedByUserId: "U", ciStatus: "success", reviews: [
      { reviewerKind: "human", reviewerId: "V", verdict: "approve" },
    ]});
    expect(d.mergeable).toBe(true);
  });

  it("a human-authored sensitive-path change still requires INDEPENDENT human code review on an org repo", () => {
    // openedByOwnerUserId === the author (a human is their own owner). On an org
    // repo SoD is on, so the author's own code approval can't satisfy the gate.
    const selfOnly = evaluateMerge({
      policy: base, risk: "low", scope: [], changedPaths: ["deploy/prod.yml"],
      openedByUserId: "U", openedByOwnerUserId: "U", namespaceType: "org", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" }],
    });
    // The author's own approval is excluded, so the change can't merge on it —
    // a different human must approve.
    expect(selfOnly.mergeable).toBe(false);
    expect(selfOnly.needsHuman).toBe(true);
    expect(selfOnly.codeReviewRequired).toBe(true);
    // A different human's code review satisfies it.
    const independent = evaluateMerge({
      policy: base, risk: "low", scope: [], changedPaths: ["deploy/prod.yml"],
      openedByUserId: "U", openedByOwnerUserId: "U", namespaceType: "org", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "W", verdict: "approve", basis: "code" }],
    });
    expect(independent.mergeable).toBe(true);
  });

  it("a solo human's sensitive-path change merges with their own code review (user repo, no SoD)", () => {
    const d = evaluateMerge({
      policy: applySoloModePreset(base), risk: "low", scope: [], changedPaths: ["scripts/deploy.sh"],
      openedByUserId: "U", openedByOwnerUserId: "U", namespaceType: "user", ciStatus: "success",
      reviews: [{ reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" }],
    });
    expect(d.mergeable).toBe(true);
    expect(d.codeReviewRequired).toBe(true);
  });
});

// --- Verified autonomy: an e2e-verification attestation (server-validated,
// head-pinned — see services/verification.ts) standing in for the human the gate
// would demand. OFF unless the policy opts in. ---
describe("evaluateMerge — verified autonomy", () => {
  const va = (over: Partial<NonNullable<MergePolicy["verifiedAutonomy"]>> = {}): MergePolicy => ({
    ...base, requireHumanApprovalLevel: "high", minApprovalsHuman: 0,
    verifiedAutonomy: { enabled: true, maxRisk: "critical", allowSensitivePaths: true, floorGlobs: [], ...over },
  });
  // The verifier agent ALSO approves (basis code) — the attestation supplies the
  // human credit; the approve verdict supplies minApprovalsTotal.
  const approve = (id = "B") => ({ reviewerKind: "agent" as const, reviewerId: id, verdict: "approve" as const, basis: "code" as const });
  const att = (agentId = "B", headCommit = "deadbeef") => ({ ok: true, agentId, headCommit });

  it("merges a HIGH-risk change with NO human when verified + opted in", () => {
    const d = evaluateMerge({ policy: va(), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(true);
    expect(d.verifiedAutonomyUsed).toBe(true);
    expect(d.satisfiedBasis).toBe("verified");
  });

  it("merges a CRITICAL-risk change when maxRisk allows it", () => {
    const d = evaluateMerge({ policy: va({ maxRisk: "critical" }), risk: "critical", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(true);
  });

  it("does not exceed maxRisk: critical blocks when maxRisk is high", () => {
    const d = evaluateMerge({ policy: va({ maxRisk: "high" }), risk: "critical", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("respects a configured floor: cannot merge .clawhub/policies/** even when verified", () => {
    const d = evaluateMerge({ policy: va({ floorGlobs: [".clawhub/policies/**"] }), risk: "high",
      scope: [], changedPaths: [".clawhub/policies/merge.yml"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("with no floor (full-autonomy posture) a verified attestation merges scripts/self-deploy.sh", () => {
    const d = evaluateMerge({ policy: va({ floorGlobs: [] }), risk: "high",
      scope: [], changedPaths: ["scripts/self-deploy.sh"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(true);
    expect(d.verifiedAutonomyUsed).toBe(true);
  });

  it("allowSensitivePaths gates whether a verified attestation covers sensitive paths (*.sql)", () => {
    const blocked = evaluateMerge({ policy: va({ allowSensitivePaths: false }), risk: "high",
      scope: [], changedPaths: ["db/x.sql"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(blocked.mergeable).toBe(false);
    const ok = evaluateMerge({ policy: va({ allowSensitivePaths: true }), risk: "high",
      scope: [], changedPaths: ["db/x.sql"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(ok.mergeable).toBe(true);
  });

  it("no self-verify: an attestation from the change's own author does not count", () => {
    const d = evaluateMerge({ policy: va(), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve("C")], verifiedAttestation: att("A") });
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("is OFF by default: an attestation is ignored unless the policy enables it", () => {
    const d = evaluateMerge({ policy: { ...base, requireHumanApprovalLevel: "high" }, risk: "high",
      scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(false);
    expect(d.needsHuman).toBe(true);
  });

  it("a non-ok (failed) attestation does not count", () => {
    const d = evaluateMerge({ policy: va(), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: { ok: false, agentId: "B", headCommit: "x" } });
    expect(d.mergeable).toBe(false);
  });

  it("the credit covers exactly one slot: minApprovalsHuman:2 still needs a human", () => {
    const policy = { ...va(), minApprovalsHuman: 2 };
    const blocked = evaluateMerge({ policy, risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(blocked.mergeable).toBe(false);
    expect(blocked.needsHuman).toBe(true);
    const ok = evaluateMerge({ policy, risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve(), { reviewerKind: "human", reviewerId: "U", verdict: "approve", basis: "code" }], verifiedAttestation: att() });
    expect(ok.mergeable).toBe(true);
  });

  it("CI still gates a verified change", () => {
    const d = evaluateMerge({ policy: { ...va(), ciRequired: true }, risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "failure",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.mergeable).toBe(false);
    expect(d.needsCi).toBe(true);
  });

  // --- minTier gate: an attestation must be produced at a tier deep enough for risk ---
  it("rejects an attestation BELOW the risk-required tier (high needs services; app too weak)", () => {
    const d = evaluateMerge({ policy: va(), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: { ok: true, agentId: "B", headCommit: "x", tier: "app" } });
    expect(d.mergeable).toBe(false);
  });
  it("accepts a services-tier attestation for a high-risk change", () => {
    const d = evaluateMerge({ policy: va(), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: { ok: true, agentId: "B", headCommit: "x", tier: "services" } });
    expect(d.verifiedAutonomyUsed).toBe(true);
  });
  it("policy.minTier raises the floor (services attestation rejected when minTier=dind)", () => {
    const d = evaluateMerge({ policy: va({ minTier: "dind" }), risk: "high", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: { ok: true, agentId: "B", headCommit: "x", tier: "services" } });
    expect(d.mergeable).toBe(false);
  });
  it("a tier-less (legacy) attestation is treated as dind and still qualifies at critical", () => {
    const d = evaluateMerge({ policy: va(), risk: "critical", scope: ["src/app.ts"], openedByAgentId: "A", ciStatus: "success",
      reviews: [approve()], verifiedAttestation: att() });
    expect(d.verifiedAutonomyUsed).toBe(true);
  });
  it("normalizeMergePolicy parses (and rejects garbage) minTier", () => {
    expect(normalizeMergePolicy({ verifiedAutonomy: { enabled: true, minTier: "services" } }).verifiedAutonomy?.minTier).toBe("services");
    expect(normalizeMergePolicy({ verifiedAutonomy: { enabled: true, minTier: "banana" } }).verifiedAutonomy?.minTier).toBeUndefined();
  });

  it("normalizeMergePolicy parses verifiedAutonomy safe-OFF + autoMergeOnVerified", () => {
    expect(normalizeMergePolicy({}).verifiedAutonomy).toBeUndefined();
    expect(normalizeMergePolicy({ verifiedAutonomy: { enabled: false } }).verifiedAutonomy).toBeUndefined();
    expect(normalizeMergePolicy({ verifiedAutonomy: "yes" }).verifiedAutonomy).toBeUndefined();
    const p = normalizeMergePolicy({ verifiedAutonomy: { enabled: true, maxRisk: "critical", allowSensitivePaths: true, floorGlobs: ["scripts/**", 5] }, autoMergeOnVerified: true });
    expect(p.verifiedAutonomy).toEqual({ enabled: true, maxRisk: "critical", allowSensitivePaths: true, floorGlobs: ["scripts/**"] });
    expect(p.autoMergeOnVerified).toBe(true);
    const q = normalizeMergePolicy({ verifiedAutonomy: { enabled: true, maxRisk: "banana" } });
    expect(q.verifiedAutonomy).toEqual({ enabled: true, maxRisk: "high", allowSensitivePaths: false, floorGlobs: [] });
  });
});
