import { describe, it, expect } from "vitest";
import { evaluateEscalation, DEFAULT_ESCALATION_RULES } from "../src/services/escalation.js";
import type { EscalationRule } from "../src/services/escalation.js";

function makeChange(overrides: Partial<{
  riskLevel: string;
  scope: string[];
  commitCount: number;
  hasConflicts: boolean;
}> = {}) {
  return {
    riskLevel: "low",
    scope: ["src/index.ts"],
    commitCount: 1,
    hasConflicts: false,
    ...overrides,
  };
}

describe("Escalation Evaluation", () => {
  describe("critical risk triggers", () => {
    it("should escalate on critical risk level", () => {
      const result = evaluateEscalation(
        makeChange({ riskLevel: "critical" }),
        null,
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("critical");
    });

    it("should not escalate on low risk level", () => {
      const result = evaluateEscalation(
        makeChange({ riskLevel: "low" }),
        null,
        { rules: DEFAULT_ESCALATION_RULES }
      );
      // Only conflict/uncertainty triggers are left, but neither applies
      expect(result).toBeNull();
    });

    it("should escalate on custom risk level trigger", () => {
      const rules: EscalationRule[] = [
        { trigger: "risk_level", value: "high", action: "require_human" },
      ];
      const result = evaluateEscalation(
        makeChange({ riskLevel: "high" }),
        null,
        { rules }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("high");
    });
  });

  describe("reviewer uncertainty triggers", () => {
    it("should escalate when review has uncertainty items", () => {
      const result = evaluateEscalation(
        makeChange(),
        { uncertainty: ["Unsure about thread safety", "Potential race condition"] },
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("uncertainty");
      expect(result!.reason).toContain("2");
    });

    it("should not escalate when review has empty uncertainty", () => {
      const result = evaluateEscalation(
        makeChange(),
        { uncertainty: [] },
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).toBeNull();
    });

    it("should not escalate when review has null uncertainty", () => {
      const result = evaluateEscalation(
        makeChange(),
        { uncertainty: null },
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).toBeNull();
    });
  });

  describe("conflict triggers", () => {
    it("should escalate when change has conflicts", () => {
      const result = evaluateEscalation(
        makeChange({ hasConflicts: true }),
        null,
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("conflict");
    });

    it("should not escalate when change has no conflicts", () => {
      const result = evaluateEscalation(
        makeChange({ hasConflicts: false }),
        null,
        { rules: DEFAULT_ESCALATION_RULES }
      );
      expect(result).toBeNull();
    });
  });

  describe("path match triggers", () => {
    it("should escalate when scope matches path pattern", () => {
      const rules: EscalationRule[] = [
        { trigger: "path_match", pattern: "src/auth/**", action: "require_human" },
      ];
      const result = evaluateEscalation(
        makeChange({ scope: ["src/auth/middleware.ts", "src/utils.ts"] }),
        null,
        { rules }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("src/auth/**");
    });

    it("should not escalate when scope does not match path pattern", () => {
      const rules: EscalationRule[] = [
        { trigger: "path_match", pattern: "src/auth/**", action: "require_human" },
      ];
      const result = evaluateEscalation(
        makeChange({ scope: ["src/utils.ts", "docs/readme.md"] }),
        null,
        { rules }
      );
      expect(result).toBeNull();
    });
  });

  describe("file count triggers", () => {
    it("should escalate when file count exceeds threshold", () => {
      const rules: EscalationRule[] = [
        { trigger: "file_count", threshold: 5, action: "surface_to_human" },
      ];
      const scope = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
      const result = evaluateEscalation(
        makeChange({ scope }),
        null,
        { rules }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
      expect(result!.reason).toContain("10");
      expect(result!.reason).toContain("5");
    });

    it("should not escalate when file count is under threshold", () => {
      const rules: EscalationRule[] = [
        { trigger: "file_count", threshold: 20, action: "surface_to_human" },
      ];
      const result = evaluateEscalation(
        makeChange({ scope: ["src/index.ts", "src/app.ts"] }),
        null,
        { rules }
      );
      expect(result).toBeNull();
    });

    it("should use default threshold of 20 when not specified", () => {
      const rules: EscalationRule[] = [
        { trigger: "file_count", action: "surface_to_human" },
      ];
      const scope = Array.from({ length: 21 }, (_, i) => `src/file${i}.ts`);
      const result = evaluateEscalation(
        makeChange({ scope }),
        null,
        { rules }
      );
      expect(result).not.toBeNull();
      expect(result!.escalate).toBe(true);
    });
  });

  describe("no match returns null", () => {
    it("should return null when no escalation rules match", () => {
      const rules: EscalationRule[] = [
        { trigger: "risk_level", value: "critical", action: "require_human" },
        { trigger: "path_match", pattern: "deploy/**", action: "require_human" },
        { trigger: "file_count", threshold: 50, action: "surface_to_human" },
      ];
      const result = evaluateEscalation(
        makeChange({ riskLevel: "low", scope: ["src/index.ts"], hasConflicts: false }),
        { uncertainty: [] },
        { rules }
      );
      expect(result).toBeNull();
    });

    it("should return null with empty rules", () => {
      const result = evaluateEscalation(
        makeChange(),
        null,
        { rules: [] }
      );
      expect(result).toBeNull();
    });

    it("should use DEFAULT_ESCALATION_RULES when policy is null", () => {
      // Default rules check: critical risk, reviewer uncertainty, conflict
      // Low risk, no review, no conflicts => no match
      const result = evaluateEscalation(
        makeChange({ riskLevel: "low", hasConflicts: false }),
        null,
        null
      );
      expect(result).toBeNull();
    });
  });
});
