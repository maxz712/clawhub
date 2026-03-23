import { minimatch } from "minimatch";

export interface EscalationRule {
  trigger:
    | "risk_level"
    | "reviewer_uncertainty"
    | "path_match"
    | "file_count"
    | "conflict";
  value?: string;
  pattern?: string;
  threshold?: number;
  action: "require_human" | "surface_to_human";
}

export const DEFAULT_ESCALATION_RULES: EscalationRule[] = [
  { trigger: "risk_level", value: "critical", action: "require_human" },
  { trigger: "reviewer_uncertainty", action: "surface_to_human" },
  { trigger: "conflict", action: "surface_to_human" },
];

/**
 * Evaluate escalation rules against a change and its review.
 * Returns the first matching rule's result, or null if no escalation is needed.
 *
 * Per design.md section 8.4:
 * - risk_level: escalate if the change's risk matches the rule's value
 * - reviewer_uncertainty: escalate if the review has uncertainty items
 * - path_match: escalate if any file in scope matches the rule's glob pattern
 * - file_count: escalate if scope (file count) exceeds the rule's threshold
 * - conflict: escalate if the change has merge conflicts
 */
export function evaluateEscalation(
  change: {
    riskLevel: string;
    scope: string[];
    commitCount: number;
    hasConflicts: boolean;
  },
  review: { uncertainty?: string[] | null } | null,
  escalationPolicy: { rules: EscalationRule[] } | null
): { escalate: boolean; reason: string } | null {
  const rules = escalationPolicy?.rules ?? DEFAULT_ESCALATION_RULES;

  for (const rule of rules) {
    switch (rule.trigger) {
      case "risk_level": {
        if (rule.value && change.riskLevel === rule.value) {
          return {
            escalate: true,
            reason: `Risk level "${change.riskLevel}" triggers escalation (action: ${rule.action})`,
          };
        }
        break;
      }

      case "reviewer_uncertainty": {
        if (
          review?.uncertainty &&
          review.uncertainty.length > 0
        ) {
          return {
            escalate: true,
            reason: `Reviewer expressed uncertainty on ${review.uncertainty.length} item(s) (action: ${rule.action})`,
          };
        }
        break;
      }

      case "path_match": {
        if (rule.pattern) {
          const matched = change.scope.some((p) =>
            minimatch(p, rule.pattern!)
          );
          if (matched) {
            return {
              escalate: true,
              reason: `File(s) match escalation pattern "${rule.pattern}" (action: ${rule.action})`,
            };
          }
        }
        break;
      }

      case "file_count": {
        const threshold = rule.threshold ?? 20;
        if (change.scope.length > threshold) {
          return {
            escalate: true,
            reason: `${change.scope.length} files exceed threshold of ${threshold} (action: ${rule.action})`,
          };
        }
        break;
      }

      case "conflict": {
        if (change.hasConflicts) {
          return {
            escalate: true,
            reason: `Change has merge conflicts (action: ${rule.action})`,
          };
        }
        break;
      }
    }
  }

  return null;
}
