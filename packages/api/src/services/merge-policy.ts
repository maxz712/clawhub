import { minimatch } from "minimatch";
import type { Risk } from "./trailer-parser.js";

export interface MergePolicy {
  requireHumanApproval: "always" | "never" | "if_risk_at_least";
  requireHumanApprovalLevel: Risk;
  minApprovalsTotal: number;
  minApprovalsHuman: number;
  allowSelfReview: boolean;
  ciRequired: boolean;
  // At or above this effective risk, the human approvals that satisfy the gate
  // must be code-level ("code"/"both") — a behavior-only approval no longer
  // counts. Defaults to "high".
  codeReviewRequiredAtRisk?: Risk;
  // Separation of duties: when true AND the code-review gate fires, a human
  // approval from the authoring agent's OWNING user does not count toward the
  // gate — an INDEPENDENT human must sign off on the code. Left undefined here,
  // evaluateMerge defaults it from the repo's namespace: TRUE for ORG repos
  // (a team must have a second pair of eyes) and FALSE for USER/solo repos
  // (the owner self-approving their own agent's change is the intended flow).
  requireIndependentApprover?: boolean;
  pathOverrides: Array<{ glob: string; requireHuman: boolean }>;
  trustedAgents: string[];
  allowedMergeMethods?: Array<"merge" | "squash" | "rebase">;
  defaultMergeMethod?: "merge" | "squash" | "rebase";
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type ReviewBasis = "behavior" | "code" | "both";

// Non-removable sensitive-path baseline. These globs ALWAYS force a human
// code-level approval, on EVERY repo, regardless of the repo's configurable
// `pathOverrides` (which a permissive policy — or a Change to that policy —
// could otherwise shrink) and regardless of when the repo's policy row was
// written. This is the code-level floor under per-repo config, mirroring how
// risk-engine floors risk deterministically.
//
// Why these: they are the paths that EXECUTE CODE ON, OR RECONFIGURE, the host
// and its trust boundary. `scripts/**` holds self-deploy.sh (merging runs it on
// the prod host); `.clawhub/ci/**` are the pipeline definitions an `on: merge`
// deploy runs; `.clawhub/policies/**` is the merge policy itself; migrations/
// *.sql mutate the database; deploy/Dockerfile/compose define the runtime. A
// malicious or careless Change to any of these must never auto-merge at low
// risk — it gets a human who read the code. See docs/governance.md + the
// 2026-06-20 security audit (deploy-path-not-sensitive finding).
export const BASELINE_SENSITIVE_GLOBS = [
  ".clawhub/policies/**",
  ".clawhub/ci/**",
  "scripts/**",
  "**/scripts/**",
  "**/migrations/**",
  "**/*.sql",
  "deploy/**",
  "**/Dockerfile",
  "docker-compose*.yml",
];

/** True when any changed path hits the non-removable sensitive baseline. */
export function touchesBaselineSensitive(paths: string[]): boolean {
  return paths.some(p => BASELINE_SENSITIVE_GLOBS.some(g => minimatch(p, g, { dot: true })));
}

/**
 * "Solo mode" preset for a team of one. A solo developer is the only human, so
 * the team-oriented separation-of-duties gate (a human who is NOT the agent's
 * owner) just blocks them from shipping their own low/medium work.
 *
 * This preset lets the developer's own approval count (`allowSelfReview: true`)
 * and requires a single total approval — but it deliberately KEEPS the
 * production backstops so solo mode never becomes "no governance":
 *   - `pathOverrides` (migrations, *.sql, deploy/**, Dockerfile, compose,
 *     `.clawhub/policies/**`) still force a human on sensitive paths.
 *   - `codeReviewRequiredAtRisk: "high"` still demands a code-level human
 *     approval on high/critical changes.
 *   - `requireHumanApprovalLevel: "high"` so medium work flows but high doesn't.
 *
 * Merges into an existing policy so a repo's other settings (merge methods,
 * trusted agents, any extra path overrides) are preserved, not clobbered.
 */
export function applySoloModePreset(current: MergePolicy): MergePolicy {
  return {
    ...current,
    requireHumanApproval: "if_risk_at_least",
    requireHumanApprovalLevel: "high",
    minApprovalsTotal: 1,
    minApprovalsHuman: 0,
    allowSelfReview: true,
    ciRequired: current.ciRequired,
    codeReviewRequiredAtRisk: "high",
  };
}

export interface MergeInputs {
  policy: MergePolicy;
  risk: Risk;
  // Server-computed risk from the diff. Effective risk = max(risk, computedRisk).
  computedRisk?: Risk;
  // Agent-declared scope (Scope: trailer). Display only — never used for gating.
  scope: string[];
  // Authoritative git-changed paths. Sensitive-path forcing reads these so an
  // agent can't dodge a code-review requirement via its Scope: trailer.
  // Falls back to scope only for pre-migration Changes that lack it.
  changedPaths?: string[];
  openedByAgentId: string;
  // The user who OWNS the authoring agent (associated_user_id ?? service_user_id
  // of openedByAgentId). Used only for the separation-of-duties gate: this
  // user's own human approval cannot be the independent reviewer of their own
  // agent's change. Null/undefined when unknown (e.g. a headless agent with no
  // service user) — the SoD gate then can't exclude anyone, so it falls open.
  openedByOwnerUserId?: string | null;
  // The repo's namespace kind. Defaults requireIndependentApprover when the
  // policy itself doesn't set it: org → true, user/agent → false.
  namespaceType?: "user" | "org" | "agent";
  reviews: Array<{ reviewerKind: "agent" | "human"; reviewerId: string; verdict: "approve" | "request_changes" | "comment"; agentName?: string; basis?: ReviewBasis }>;
  ciStatus: "pending" | "running" | "success" | "failure" | "skipped";
}

export interface MergeDecision {
  mergeable: boolean;
  reason?: string;
  needsHuman: boolean;
  needsCi: boolean;
  // True when the effective risk / path forced a code-level human review.
  codeReviewRequired?: boolean;
  // The strongest human-approval basis that satisfied the gate, for the audit
  // trail ("code" or "both" when code review was required; "behavior" when a
  // behavior-only human approval sufficed; undefined when no human was needed).
  satisfiedBasis?: ReviewBasis;
  // True when the separation-of-duties gate was active (an independent human,
  // not the authoring agent's owner, had to approve).
  independentApproverRequired?: boolean;
}

export function evaluateMerge(i: MergeInputs): MergeDecision {
  const { policy, openedByAgentId, reviews, ciStatus } = i;
  // Gating reads authoritative changed paths, not the agent-declared scope.
  const gatePaths = i.changedPaths && i.changedPaths.length ? i.changedPaths : i.scope;

  // Effective risk is the higher of agent-declared and server-computed: an
  // agent can never talk its way below what the diff actually warrants.
  const risk: Risk = i.computedRisk && RISK_ORDER[i.computedRisk] > RISK_ORDER[i.risk] ? i.computedRisk : i.risk;

  if (reviews.some(r => r.verdict === "request_changes")) {
    return { mergeable: false, reason: "changes_requested", needsHuman: false, needsCi: false };
  }

  const needsCi = policy.ciRequired && ciStatus !== "success" && ciStatus !== "skipped";
  if (needsCi) {
    return { mergeable: false, reason: `ci_${ciStatus}`, needsHuman: false, needsCi: true };
  }

  const approvals = reviews.filter(r => r.verdict === "approve" && (policy.allowSelfReview || r.reviewerId !== openedByAgentId));
  const humanApprovals = approvals.filter(r => r.reviewerKind === "human");

  const pathForcesHuman = touchesBaselineSensitive(gatePaths)
    || gatePaths.some(p => policy.pathOverrides.some(o => o.requireHuman && minimatch(p, o.glob, { dot: true })));
  const riskForcesHuman = policy.requireHumanApproval === "always"
    || (policy.requireHumanApproval === "if_risk_at_least" && RISK_ORDER[risk] >= RISK_ORDER[policy.requireHumanApprovalLevel]);
  const humansRequired = Math.max(policy.minApprovalsHuman, pathForcesHuman || riskForcesHuman ? 1 : 0);

  // Code-level review gate: at/above this risk (or when a path override forces a
  // human), the human approvals that satisfy humansRequired must be based on
  // reading the code — a behavior-only approval does not count for those slots.
  const codeGateLevel = policy.codeReviewRequiredAtRisk ?? "high";
  const codeReviewRequired = pathForcesHuman || RISK_ORDER[risk] >= RISK_ORDER[codeGateLevel];
  let qualifyingHumanApprovals = codeReviewRequired
    ? humanApprovals.filter(r => r.basis === "code" || r.basis === "both")
    : humanApprovals;

  // Separation of duties: when the code-review gate fires, the human who signs
  // off on the code must be INDEPENDENT of the change's author — i.e. not the
  // user who owns the authoring agent. Defaults on for ORG repos (a team needs a
  // second reviewer) and off for USER/solo repos (the owner self-approving their
  // own agent's change is the intended persona-1 flow). The exclusion only bites
  // when code review is required; low-risk self-merge under threshold is
  // untouched.
  const requireIndependent = policy.requireIndependentApprover ?? (i.namespaceType === "org");
  const independentApproverRequired = codeReviewRequired && requireIndependent && !!i.openedByOwnerUserId;
  if (independentApproverRequired) {
    qualifyingHumanApprovals = qualifyingHumanApprovals.filter(r => r.reviewerId !== i.openedByOwnerUserId);
  }

  if (qualifyingHumanApprovals.length < humansRequired) {
    // Distinguish the failure modes so the UI can say WHY:
    //  - an independent reviewer is missing (author's owner approved, but no one else)
    //  - a code-level review is missing (a human approved on behavior only)
    //  - no human approved at all
    let reason: string;
    if (independentApproverRequired
        && humanApprovals.filter(r => r.basis === "code" || r.basis === "both").length >= humansRequired) {
      reason = "needs_independent_approver";
    } else if (codeReviewRequired && humanApprovals.length >= humansRequired) {
      reason = "needs_code_review";
    } else {
      reason = "needs_human_approval";
    }
    return { mergeable: false, reason, needsHuman: true, needsCi: false, codeReviewRequired, independentApproverRequired };
  }

  // Trusted agent approval can stand in for general approvals on low-risk.
  const trustedAgentApprovals = approvals.filter(r => r.reviewerKind === "agent" && r.agentName && policy.trustedAgents.includes(r.agentName));
  const effectiveApprovals = approvals.length + (risk === "low" ? trustedAgentApprovals.length : 0);

  if (effectiveApprovals < policy.minApprovalsTotal) {
    return { mergeable: false, reason: "needs_more_approvals", needsHuman: false, needsCi: false, codeReviewRequired, independentApproverRequired };
  }

  // Record which human-approval basis satisfied the gate, for the audit trail.
  let satisfiedBasis: ReviewBasis | undefined;
  if (humansRequired > 0 && qualifyingHumanApprovals.length) {
    satisfiedBasis = qualifyingHumanApprovals.some(r => r.basis === "both")
      ? "both"
      : qualifyingHumanApprovals.some(r => r.basis === "code")
        ? "code"
        : "behavior";
  }

  return { mergeable: true, needsHuman: false, needsCi: false, codeReviewRequired, satisfiedBasis, independentApproverRequired };
}
