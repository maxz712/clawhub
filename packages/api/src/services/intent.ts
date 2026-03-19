export interface RiskAnalysis {
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
  architecturalImpact: string | null;
  suggestedReviewers: string[];
}

/**
 * Heuristic-based risk classification from file paths, actions, and counts.
 * No LLM needed — agents provide intent/risk in git trailers.
 * This is the fallback when trailers are missing or incomplete.
 */
export function analyzeRisk(params: {
  intent: string;
  description?: string;
  files: { path: string; action: string; content?: string }[];
  existingRiskLevel?: string;
}): RiskAnalysis {
  const paths = params.files.map((f) => f.path);
  const actions = params.files.map((f) => f.action);

  let riskLevel: RiskAnalysis["riskLevel"] = "low";

  // Check for critical patterns
  const criticalPatterns = [
    /migration/i,
    /payment/i,
    /billing/i,
    /\.env/,
    /secret/i,
    /credential/i,
  ];
  const highPatterns = [
    /auth/i,
    /security/i,
    /middleware/i,
    /permission/i,
    /infrastructure/i,
    /docker/i,
    /ci\/cd/i,
    /\.ya?ml$/,
  ];
  const mediumPatterns = [
    /service/i,
    /route/i,
    /api/i,
    /model/i,
    /schema/i,
    /database/i,
    /db/i,
  ];

  for (const p of paths) {
    if (criticalPatterns.some((pat) => pat.test(p))) {
      riskLevel = "critical";
      break;
    }
    if (highPatterns.some((pat) => pat.test(p))) {
      if (riskLevel !== "critical") riskLevel = "high";
    }
    if (mediumPatterns.some((pat) => pat.test(p))) {
      if (riskLevel === "low") riskLevel = "medium";
    }
  }

  // File count heuristic
  if (params.files.length > 10 && riskLevel === "low") {
    riskLevel = "medium";
  }
  if (params.files.length > 20 && riskLevel === "medium") {
    riskLevel = "high";
  }

  // Deletions increase risk
  if (actions.includes("delete") && riskLevel === "low") {
    riskLevel = "medium";
  }

  // If the caller provided an existing risk level, take the higher one
  if (params.existingRiskLevel) {
    const levels = ["low", "medium", "high", "critical"];
    const existingIdx = levels.indexOf(params.existingRiskLevel);
    const computedIdx = levels.indexOf(riskLevel);
    if (existingIdx > computedIdx) {
      riskLevel = params.existingRiskLevel as RiskAnalysis["riskLevel"];
    }
  }

  return {
    riskLevel,
    summary: params.description ?? params.intent,
    architecturalImpact: null,
    suggestedReviewers: [],
  };
}
