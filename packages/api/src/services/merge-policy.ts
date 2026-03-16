import { minimatch } from "minimatch";
import type { Review } from "../models/schema.js";

export interface MergePolicy {
  require_human_approval: boolean;
  min_approvals: number;
  agent_approval_weight: number;
  auto_merge_rules: {
    risk: string[];
    max_files?: number;
  } | null;
  path_overrides?: Record<
    string,
    {
      require_human_approval?: boolean;
      min_approvals?: number;
    }
  >;
}

export interface MergeEvaluation {
  allowed: boolean;
  reason: string;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  require_human_approval: true,
  min_approvals: 1,
  agent_approval_weight: 0.5,
  auto_merge_rules: null,
};

/**
 * Evaluate whether a change can be merged based on the repo's merge policy,
 * the change's risk level, and the reviews submitted.
 */
export function canMerge(
  policy: MergePolicy,
  change: {
    riskLevel: string;
    scope: string[];
    commitCount: number;
  },
  reviews: Pick<Review, "verdict" | "reviewerType">[]
): MergeEvaluation {
  // Check auto-merge rules first
  if (policy.auto_merge_rules) {
    const riskMatch = policy.auto_merge_rules.risk?.includes(change.riskLevel);
    const fileMatch =
      !policy.auto_merge_rules.max_files ||
      change.commitCount <= policy.auto_merge_rules.max_files;
    if (riskMatch && fileMatch) {
      return { allowed: true, reason: "Auto-merge: matches low-risk rules" };
    }
  }

  // Count weighted approvals
  const approvals = reviews.filter((r) => r.verdict === "approve");
  const humanApprovals = approvals.filter((r) => r.reviewerType === "human");
  const agentApprovals = approvals.filter((r) => r.reviewerType === "agent");

  const totalWeight =
    humanApprovals.length +
    agentApprovals.length * policy.agent_approval_weight;

  if (policy.require_human_approval && humanApprovals.length === 0) {
    return { allowed: false, reason: "Requires at least one human approval" };
  }

  if (totalWeight < policy.min_approvals) {
    return {
      allowed: false,
      reason: `Needs ${policy.min_approvals} approvals, has ${totalWeight}`,
    };
  }

  // Check path overrides
  const changedPaths = change.scope || [];
  for (const [pattern, override] of Object.entries(
    policy.path_overrides || {}
  )) {
    const matchingPaths = changedPaths.filter((p) => minimatch(p, pattern));
    if (matchingPaths.length > 0) {
      if (override.require_human_approval && humanApprovals.length === 0) {
        return {
          allowed: false,
          reason: `Path ${pattern} requires human approval`,
        };
      }
      if (
        override.min_approvals &&
        totalWeight < override.min_approvals
      ) {
        return {
          allowed: false,
          reason: `Path ${pattern} requires ${override.min_approvals} approvals`,
        };
      }
    }
  }

  return { allowed: true, reason: "All merge requirements met" };
}
