import { minimatch } from "minimatch";
import type { Risk } from "./trailer-parser.js";

export interface MergePolicy {
  requireHumanApproval: "always" | "never" | "if_risk_at_least";
  requireHumanApprovalLevel: Risk;
  minApprovalsTotal: number;
  minApprovalsHuman: number;
  allowSelfReview: boolean;
  ciRequired: boolean;
  pathOverrides: Array<{ glob: string; requireHuman: boolean }>;
  trustedAgents: string[];
  allowedMergeMethods?: Array<"merge" | "squash" | "rebase">;
  defaultMergeMethod?: "merge" | "squash" | "rebase";
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface MergeInputs {
  policy: MergePolicy;
  risk: Risk;
  scope: string[];
  openedByAgentId: string;
  reviews: Array<{ reviewerKind: "agent" | "human"; reviewerId: string; verdict: "approve" | "request_changes" | "comment"; agentName?: string }>;
  ciStatus: "pending" | "running" | "success" | "failure" | "skipped";
}

export interface MergeDecision {
  mergeable: boolean;
  reason?: string;
  needsHuman: boolean;
  needsCi: boolean;
}

export function evaluateMerge(i: MergeInputs): MergeDecision {
  const { policy, risk, scope, openedByAgentId, reviews, ciStatus } = i;

  if (reviews.some(r => r.verdict === "request_changes")) {
    return { mergeable: false, reason: "changes_requested", needsHuman: false, needsCi: false };
  }

  const needsCi = policy.ciRequired && ciStatus !== "success" && ciStatus !== "skipped";
  if (needsCi) {
    return { mergeable: false, reason: `ci_${ciStatus}`, needsHuman: false, needsCi: true };
  }

  const approvals = reviews.filter(r => r.verdict === "approve" && (policy.allowSelfReview || r.reviewerId !== openedByAgentId));
  const humanApprovals = approvals.filter(r => r.reviewerKind === "human");

  const pathForcesHuman = scope.some(p => policy.pathOverrides.some(o => o.requireHuman && minimatch(p, o.glob)));
  const riskForcesHuman = policy.requireHumanApproval === "always"
    || (policy.requireHumanApproval === "if_risk_at_least" && RISK_ORDER[risk] >= RISK_ORDER[policy.requireHumanApprovalLevel]);
  const humansRequired = Math.max(policy.minApprovalsHuman, pathForcesHuman || riskForcesHuman ? 1 : 0);

  if (humanApprovals.length < humansRequired) {
    return { mergeable: false, reason: "needs_human_approval", needsHuman: true, needsCi: false };
  }

  // Trusted agent approval can stand in for general approvals on low-risk.
  const trustedAgentApprovals = approvals.filter(r => r.reviewerKind === "agent" && r.agentName && policy.trustedAgents.includes(r.agentName));
  const effectiveApprovals = approvals.length + (risk === "low" ? trustedAgentApprovals.length : 0);

  if (effectiveApprovals < policy.minApprovalsTotal) {
    return { mergeable: false, reason: "needs_more_approvals", needsHuman: false, needsCi: false };
  }

  return { mergeable: true, needsHuman: false, needsCi: false };
}
