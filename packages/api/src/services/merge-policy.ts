import { minimatch } from "minimatch";

export interface MergePolicy {
  min_approvals: number;
  agent_approvals_sufficient: boolean; // default true -- agent approvals count
  self_review_allowed: boolean; // default false
  escalation_overrides_merge: boolean; // default true
  require_human_approval_for?: string[]; // risk levels that need human, e.g. ["high", "critical"]
  auto_merge_on_push?: { risk: string[]; max_files?: number }; // auto-merge rules
  path_overrides?: Record<string, { require_human_approval?: boolean }>;
}

export interface MergeEvaluation {
  allowed: boolean;
  reason: string;
}

export const DEFAULT_MERGE_POLICY: MergePolicy = {
  min_approvals: 1,
  agent_approvals_sufficient: true,
  self_review_allowed: false,
  escalation_overrides_merge: true,
  require_human_approval_for: ["critical"],
};

/**
 * Evaluate whether a change can be merged based on the repo's merge policy,
 * the change's risk level/scope/escalation state, and the submitted reviews.
 *
 * Evaluation order (per design.md section 8.3):
 * 1. Escalation override check
 * 2. Auto-merge on push rules
 * 3. Self-review filtering
 * 4. Approval counting (agent vs human)
 * 5. Risk-based human approval requirement
 * 6. Path overrides
 * 7. Min approvals threshold
 */
export function canMerge(
  policy: MergePolicy,
  change: {
    riskLevel: string;
    scope: string[];
    authorId: string;
    escalated: boolean;
    commitCount: number;
  },
  reviews: Array<{
    verdict: string;
    reviewerId: string;
    reviewerType: string;
  }>
): MergeEvaluation {
  // 1. Escalation override: if change is escalated and policy says escalation
  //    overrides merge, require at least one human review to proceed
  if (change.escalated && policy.escalation_overrides_merge) {
    const humanReviews = reviews.filter(
      (r) => r.reviewerType === "human" && r.verdict === "approve"
    );
    if (humanReviews.length === 0) {
      return {
        allowed: false,
        reason:
          "Change is escalated; requires at least one human approval to merge",
      };
    }
  }

  // 2. Auto-merge on push: if risk level and file count match, allow immediately
  if (policy.auto_merge_on_push) {
    const riskMatch = policy.auto_merge_on_push.risk.includes(
      change.riskLevel
    );
    const fileMatch =
      policy.auto_merge_on_push.max_files == null ||
      change.commitCount <= policy.auto_merge_on_push.max_files;
    if (riskMatch && fileMatch) {
      return { allowed: true, reason: "Auto-merge: matches low-risk rules" };
    }
  }

  // 3. Filter out self-reviews unless policy allows them
  const effectiveReviews = policy.self_review_allowed
    ? reviews
    : reviews.filter((r) => r.reviewerId !== change.authorId);

  // 4. Count approvals, separated by type
  const approvals = effectiveReviews.filter((r) => r.verdict === "approve");
  const humanApprovals = approvals.filter((r) => r.reviewerType === "human");
  const agentApprovals = approvals.filter((r) => r.reviewerType === "agent");

  // 5. Check require_human_approval_for risk levels
  if (policy.require_human_approval_for?.includes(change.riskLevel)) {
    if (humanApprovals.length === 0) {
      return {
        allowed: false,
        reason: `Risk level "${change.riskLevel}" requires at least one human approval`,
      };
    }
  }

  // 6. Check path overrides
  const changedPaths = change.scope || [];
  for (const [pattern, override] of Object.entries(
    policy.path_overrides || {}
  )) {
    const matchingPaths = changedPaths.filter((p) => minimatch(p, pattern));
    if (matchingPaths.length > 0) {
      if (override.require_human_approval && humanApprovals.length === 0) {
        return {
          allowed: false,
          reason: `Path "${pattern}" requires human approval`,
        };
      }
    }
  }

  // 7. Check min_approvals threshold
  const countedApprovals = policy.agent_approvals_sufficient
    ? approvals.length // all approvals count equally
    : humanApprovals.length; // only human approvals count

  if (countedApprovals < policy.min_approvals) {
    return {
      allowed: false,
      reason: `Needs ${policy.min_approvals} approval(s), has ${countedApprovals}`,
    };
  }

  return { allowed: true, reason: "All merge requirements met" };
}
