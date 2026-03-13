import Anthropic from "@anthropic-ai/sdk";

export interface IntentAnalysis {
  riskLevel: "low" | "medium" | "high" | "critical";
  summary: string;
  architecturalImpact: string | null;
  suggestedReviewers: string[];
}

export interface IntentEngineConfig {
  apiKey?: string;
  model?: string;
}

export class IntentEngine {
  private client: Anthropic | null = null;
  private model: string;

  constructor(config: IntentEngineConfig = {}) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.model = config.model ?? "claude-sonnet-4-20250514";

    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  /**
   * Analyze a change submission to classify risk and generate a summary.
   * Falls back to heuristic-based classification if the LLM is unavailable.
   */
  async analyzeChange(params: {
    intent: string;
    description?: string;
    files: { path: string; action: string; content?: string }[];
    existingRiskLevel?: string;
  }): Promise<IntentAnalysis> {
    if (!this.client) {
      return this.heuristicAnalysis(params);
    }

    try {
      return await this.llmAnalysis(params);
    } catch (error) {
      console.error("Intent engine LLM call failed, falling back to heuristic:", error);
      return this.heuristicAnalysis(params);
    }
  }

  private async llmAnalysis(params: {
    intent: string;
    description?: string;
    files: { path: string; action: string; content?: string }[];
  }): Promise<IntentAnalysis> {
    const fileList = params.files
      .map((f) => `- ${f.path} (${f.action})`)
      .join("\n");

    const prompt = `You are a code change risk classifier for a code hosting platform. Analyze this change and respond with JSON only.

Change Intent: ${params.intent}
${params.description ? `Description: ${params.description}` : ""}

Files changed:
${fileList}

Respond with a JSON object containing:
- "risk_level": one of "low", "medium", "high", "critical"
- "summary": a 1-2 sentence human-readable summary of what this change does
- "architectural_impact": null if no architectural impact, or a brief description if there is one
- "suggested_reviewers": an empty array (no user data to suggest from)

Risk level guidelines:
- low: documentation, tests, simple config changes, adding new isolated files
- medium: modifying existing business logic, changing API contracts, database changes
- high: authentication/authorization changes, security-sensitive code, infrastructure changes
- critical: database migrations that alter existing data, changes to payment/billing, changes that could cause data loss

Respond with ONLY the JSON object, no markdown formatting.`;

    const response = await this.client!.messages.create({
      model: this.model,
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    try {
      const parsed = JSON.parse(text);
      return {
        riskLevel: parsed.risk_level ?? "medium",
        summary: parsed.summary ?? params.intent,
        architecturalImpact: parsed.architectural_impact ?? null,
        suggestedReviewers: parsed.suggested_reviewers ?? [],
      };
    } catch {
      // If JSON parsing fails, fall back to heuristic
      return this.heuristicAnalysis({
        intent: params.intent,
        files: params.files,
      });
    }
  }

  /**
   * Heuristic-based risk classification when LLM is unavailable.
   */
  private heuristicAnalysis(params: {
    intent: string;
    description?: string;
    files: { path: string; action: string; content?: string }[];
    existingRiskLevel?: string;
  }): IntentAnalysis {
    const paths = params.files.map((f) => f.path);
    const actions = params.files.map((f) => f.action);

    let riskLevel: IntentAnalysis["riskLevel"] = "low";

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
        riskLevel = params.existingRiskLevel as IntentAnalysis["riskLevel"];
      }
    }

    return {
      riskLevel,
      summary: params.description ?? params.intent,
      architecturalImpact: null,
      suggestedReviewers: [],
    };
  }
}
