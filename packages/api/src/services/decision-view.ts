import type { Change, Review, HumanSummary } from "../models/schema.js";

export interface DecisionView {
  change_id: string;
  intent: string | null;
  risk_level: string;
  status: string;

  human_summary: {
    headline: string;
    what_happened: string;
    why_care: string;
    key_decisions: Array<{
      choice: string;
      tradeoff: string;
      code_focus: {
        path: string;
        lines: string;
        snippet?: string;
      } | null;
    }>;
    uncertainty: string;
    recommendation: string;
    confidence: string;
  } | null;

  decisions: Array<{
    description: string;
    reviewer_assessment: string | null;
    code_focus: { path: string; lines: string } | null;
  }>;
  uncertainty: string[];
  verified_scope: string[];
  unverified_scope: string[];
  reviews: Array<{
    reviewer: string;
    reviewer_type: string;
    verdict: string;
    summary: string | null;
  }>;
  escalation_reason: string | null;
}

/**
 * Build a decision-centric view of a change, aggregating the author's
 * decisions with reviewer assessments and collecting uncertainty/scope
 * data across all reviews.
 *
 * Per design.md section 8.2, this is the primary view for human supervisors.
 * When a HumanSummary exists (generated on escalation), it is included.
 * Otherwise human_summary is null and the raw decisions/uncertainty are used.
 */
export function buildDecisionView(
  change: Change,
  reviews: Review[],
  agentNames: Map<string, string>,
  humanSummary?: HumanSummary | null
): DecisionView {
  // Parse author decisions from the change record.
  const rawDecisions = (change.decisions ?? []) as Array<
    string | { description: string; code_focus?: { path: string; lines: string } }
  >;

  // Collect reviewer decision assessments.
  const decisions = rawDecisions.map((d, idx) => {
    const description = typeof d === "string" ? d : d.description;
    const codeFocus =
      typeof d === "string" ? null : d.code_focus ?? null;

    let reviewerAssessment: string | null = null;
    for (const review of reviews) {
      const reviewDecisions = review.decisions as
        | Record<string, string>
        | Array<{ index: number; assessment: string }>
        | null;

      if (Array.isArray(reviewDecisions)) {
        const match = reviewDecisions.find((rd) => rd.index === idx);
        if (match) {
          reviewerAssessment = match.assessment;
          break;
        }
      } else if (reviewDecisions && typeof reviewDecisions === "object") {
        const key = String(idx);
        if (key in reviewDecisions) {
          reviewerAssessment = (reviewDecisions as Record<string, string>)[key];
          break;
        }
      }
    }

    return { description, reviewer_assessment: reviewerAssessment, code_focus: codeFocus };
  });

  // Aggregate uncertainty across all reviews
  const uncertainty: string[] = [];
  const verifiedScope: string[] = [];
  const unverifiedScope: string[] = [];

  for (const review of reviews) {
    if (review.uncertainty) {
      for (const item of review.uncertainty) {
        if (!uncertainty.includes(item)) {
          uncertainty.push(item);
        }
      }
    }
    if (review.verifiedScope) {
      for (const item of review.verifiedScope) {
        if (!verifiedScope.includes(item)) {
          verifiedScope.push(item);
        }
      }
    }
    if (review.unverifiedScope) {
      for (const item of review.unverifiedScope) {
        if (!unverifiedScope.includes(item)) {
          unverifiedScope.push(item);
        }
      }
    }
  }

  // Build review summaries
  const reviewSummaries = reviews.map((r) => ({
    reviewer: agentNames.get(r.reviewerId) ?? r.reviewerId,
    reviewer_type: r.reviewerType,
    verdict: r.verdict,
    summary: r.summary,
  }));

  // Format human summary if available
  let formattedSummary: DecisionView["human_summary"] = null;
  if (humanSummary) {
    const keyDecisions = (humanSummary.keyDecisions ?? []) as Array<{
      choice: string;
      tradeoff: string;
      code_path?: string;
      code_lines?: string;
    }>;

    formattedSummary = {
      headline: humanSummary.headline,
      what_happened: humanSummary.whatHappened,
      why_care: humanSummary.whyCare,
      key_decisions: keyDecisions.map((kd) => ({
        choice: kd.choice,
        tradeoff: kd.tradeoff,
        code_focus: kd.code_path
          ? { path: kd.code_path, lines: kd.code_lines ?? "" }
          : null,
      })),
      uncertainty: humanSummary.uncertainty,
      recommendation: humanSummary.recommendation,
      confidence: humanSummary.confidence,
    };
  }

  return {
    change_id: change.id,
    intent: change.intent,
    risk_level: change.riskLevel,
    status: change.status,
    human_summary: formattedSummary,
    decisions,
    uncertainty,
    verified_scope: verifiedScope,
    unverified_scope: unverifiedScope,
    reviews: reviewSummaries,
    escalation_reason: change.escalationReason,
  };
}
