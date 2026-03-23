/**
 * Schema validation for agent-submitted human summaries.
 *
 * ClawForge never runs an LLM — the owner's agent generates summaries
 * and submits them via the API. This validator enforces the required
 * schema using simple text parsing with actionable error messages.
 */

export interface HumanSummarySubmission {
  headline: string;
  what_happened: string;
  why_care: string;
  key_decisions: Array<{
    choice: string;
    tradeoff: string;
    code_path: string;
    code_lines: string;
  }>;
  uncertainty: string;
  recommendation: "approve" | "reject" | "needs_discussion";
  confidence: "high" | "medium" | "low";
}

export interface SummaryValidationError {
  field: string;
  error: string;
  hint: string;
}

export type ValidationResult =
  | { valid: true; summary: HumanSummarySubmission }
  | { valid: false; errors: SummaryValidationError[] };

const CHAR_LIMITS: Record<string, number> = {
  headline: 200,
  what_happened: 1000,
  why_care: 1000,
  uncertainty: 1000,
};

const VALID_RECOMMENDATIONS = ["approve", "reject", "needs_discussion"];
const VALID_CONFIDENCES = ["high", "medium", "low"];

export function validateHumanSummary(
  body: Record<string, unknown>,
  changeScope: string[]
): ValidationResult {
  const errors: SummaryValidationError[] = [];

  // Required string fields
  const requiredStringFields = [
    "headline",
    "what_happened",
    "why_care",
    "uncertainty",
  ];
  for (const field of requiredStringFields) {
    const value = body[field];
    if (!value || typeof value !== "string" || value.trim().length === 0) {
      errors.push({
        field,
        error: `Missing or empty required field: ${field}`,
        hint: `Provide a non-empty string for "${field}".`,
      });
    }
  }

  // Character limits
  for (const [field, max] of Object.entries(CHAR_LIMITS)) {
    const value = body[field];
    if (typeof value === "string" && value.length > max) {
      errors.push({
        field,
        error: `"${field}" exceeds ${max} character limit (got ${value.length})`,
        hint: `Shorten "${field}" to ${max} characters or less.`,
      });
    }
  }

  // recommendation enum
  if (!VALID_RECOMMENDATIONS.includes(body.recommendation as string)) {
    errors.push({
      field: "recommendation",
      error: `Invalid recommendation: "${body.recommendation}"`,
      hint: `Must be one of: ${VALID_RECOMMENDATIONS.map((r) => `"${r}"`).join(", ")}.`,
    });
  }

  // confidence enum
  if (!VALID_CONFIDENCES.includes(body.confidence as string)) {
    errors.push({
      field: "confidence",
      error: `Invalid confidence: "${body.confidence}"`,
      hint: `Must be one of: ${VALID_CONFIDENCES.map((c) => `"${c}"`).join(", ")}.`,
    });
  }

  // key_decisions array
  const kd = body.key_decisions;
  if (!Array.isArray(kd) || kd.length === 0) {
    errors.push({
      field: "key_decisions",
      error: "key_decisions must be a non-empty array",
      hint: "Provide at least one decision with {choice, tradeoff, code_path, code_lines}.",
    });
  } else if (kd.length > 10) {
    errors.push({
      field: "key_decisions",
      error: `Too many decisions (${kd.length}). Maximum is 10.`,
      hint: "Summarize into the 10 most important decisions.",
    });
  } else {
    for (let i = 0; i < kd.length; i++) {
      const d = kd[i] as Record<string, unknown>;

      if (!d.choice || !d.tradeoff || !d.code_path || !d.code_lines) {
        errors.push({
          field: `key_decisions[${i}]`,
          error:
            "Each decision must have choice, tradeoff, code_path, and code_lines",
          hint: "Ensure all four fields are present and non-empty.",
        });
      }

      // code_path must reference a file in the change's scope
      if (
        typeof d.code_path === "string" &&
        d.code_path.length > 0 &&
        !changeScope.includes(d.code_path)
      ) {
        errors.push({
          field: `key_decisions[${i}].code_path`,
          error: `"${d.code_path}" is not in the change's scope`,
          hint: `code_path must reference a file in the change. Valid files: ${changeScope.join(", ")}`,
        });
      }

      if (typeof d.choice === "string" && d.choice.length > 200) {
        errors.push({
          field: `key_decisions[${i}].choice`,
          error: `"choice" exceeds 200 character limit`,
          hint: "Shorten the choice description.",
        });
      }

      if (typeof d.tradeoff === "string" && d.tradeoff.length > 500) {
        errors.push({
          field: `key_decisions[${i}].tradeoff`,
          error: `"tradeoff" exceeds 500 character limit`,
          hint: "Shorten the tradeoff description.",
        });
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, summary: body as unknown as HumanSummarySubmission };
}

export interface HumanSummaryConfig {
  summary_triggers: string[];
  summary_on_all_changes: boolean;
}

export const DEFAULT_SUMMARY_CONFIG: HumanSummaryConfig = {
  summary_triggers: ["escalation"],
  summary_on_all_changes: false,
};

/**
 * Check whether a summary should be requested from the owner's agent.
 */
export function shouldRequestSummary(
  config: HumanSummaryConfig,
  trigger: "escalation" | "all_changes"
): boolean {
  if (trigger === "all_changes") {
    return config.summary_on_all_changes;
  }
  return config.summary_triggers.includes(trigger);
}
