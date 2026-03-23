import { describe, it, expect } from "vitest";
import { canMerge, DEFAULT_MERGE_POLICY } from "../src/services/merge-policy.js";
import type { MergePolicy } from "../src/services/merge-policy.js";

function makeChange(overrides: Partial<{
  riskLevel: string;
  scope: string[];
  authorId: string;
  escalated: boolean;
  commitCount: number;
}> = {}) {
  return {
    riskLevel: "low",
    scope: ["src/index.ts"],
    authorId: "agent-1",
    escalated: false,
    commitCount: 1,
    ...overrides,
  };
}

function makeReview(overrides: Partial<{
  verdict: string;
  reviewerId: string;
  reviewerType: string;
}> = {}) {
  return {
    verdict: "approve",
    reviewerId: "reviewer-1",
    reviewerType: "agent",
    ...overrides,
  };
}

describe("Merge Policy (canMerge)", () => {
  describe("agent approvals sufficient (default policy)", () => {
    it("should allow merge with one agent approval", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange(),
        [makeReview()]
      );
      expect(result.allowed).toBe(true);
    });

    it("should deny merge with zero approvals", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange(),
        []
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("approval");
    });

    it("should deny merge when only request_changes reviews exist", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange(),
        [makeReview({ verdict: "request_changes" })]
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("self-review blocked", () => {
    it("should not count self-review when self_review_allowed is false", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        self_review_allowed: false,
      };
      const result = canMerge(
        policy,
        makeChange({ authorId: "agent-1" }),
        [makeReview({ reviewerId: "agent-1" })]
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("approval");
    });

    it("should count self-review when self_review_allowed is true", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        self_review_allowed: true,
      };
      const result = canMerge(
        policy,
        makeChange({ authorId: "agent-1" }),
        [makeReview({ reviewerId: "agent-1" })]
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("escalation overrides merge", () => {
    it("should block merge when escalated and no human approval", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange({ escalated: true }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("escalated");
    });

    it("should allow merge when escalated with human approval", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange({ escalated: true }),
        [makeReview({ reviewerType: "human", reviewerId: "user-1" })]
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow escalated merge when escalation_overrides_merge is false", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        escalation_overrides_merge: false,
      };
      const result = canMerge(
        policy,
        makeChange({ escalated: true }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("auto-merge on push rules", () => {
    it("should auto-merge when risk and file count match", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        auto_merge_on_push: { risk: ["low"], max_files: 5 },
      };
      const result = canMerge(
        policy,
        makeChange({ riskLevel: "low", commitCount: 2 }),
        [] // no reviews needed for auto-merge
      );
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Auto-merge");
    });

    it("should not auto-merge when risk level does not match", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        auto_merge_on_push: { risk: ["low"], max_files: 5 },
      };
      const result = canMerge(
        policy,
        makeChange({ riskLevel: "high", commitCount: 1 }),
        []
      );
      expect(result.allowed).toBe(false);
    });

    it("should not auto-merge when file count exceeds max", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        auto_merge_on_push: { risk: ["low"], max_files: 2 },
      };
      const result = canMerge(
        policy,
        makeChange({ riskLevel: "low", commitCount: 5 }),
        []
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("human approval required for specific risk levels", () => {
    it("should require human approval for critical risk (default policy)", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange({ riskLevel: "critical" }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("human approval");
    });

    it("should allow critical risk with human approval", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange({ riskLevel: "critical" }),
        [makeReview({ reviewerType: "human", reviewerId: "user-1" })]
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow low risk without human approval", () => {
      const result = canMerge(
        DEFAULT_MERGE_POLICY,
        makeChange({ riskLevel: "low" }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("path overrides", () => {
    it("should require human approval for matching path overrides", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        path_overrides: {
          "src/auth/**": { require_human_approval: true },
        },
      };
      const result = canMerge(
        policy,
        makeChange({ scope: ["src/auth/middleware.ts"] }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("human approval");
    });

    it("should allow when path override matches but human approved", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        path_overrides: {
          "src/auth/**": { require_human_approval: true },
        },
      };
      const result = canMerge(
        policy,
        makeChange({ scope: ["src/auth/middleware.ts"] }),
        [makeReview({ reviewerType: "human", reviewerId: "user-1" })]
      );
      expect(result.allowed).toBe(true);
    });

    it("should not trigger path override when paths do not match", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        path_overrides: {
          "src/auth/**": { require_human_approval: true },
        },
      };
      const result = canMerge(
        policy,
        makeChange({ scope: ["src/utils/helper.ts"] }),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("min_approvals threshold", () => {
    it("should require the specified number of approvals", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        min_approvals: 2,
      };
      const result = canMerge(
        policy,
        makeChange(),
        [makeReview()]
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("2 approval");
    });

    it("should pass with enough approvals", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        min_approvals: 2,
      };
      const result = canMerge(
        policy,
        makeChange(),
        [
          makeReview({ reviewerId: "reviewer-1" }),
          makeReview({ reviewerId: "reviewer-2" }),
        ]
      );
      expect(result.allowed).toBe(true);
    });

    it("should only count human approvals when agent_approvals_sufficient is false", () => {
      const policy: MergePolicy = {
        ...DEFAULT_MERGE_POLICY,
        agent_approvals_sufficient: false,
        min_approvals: 1,
      };
      const result = canMerge(
        policy,
        makeChange(),
        [makeReview({ reviewerType: "agent" })]
      );
      expect(result.allowed).toBe(false);
    });
  });
});
