import { describe, it, expect } from "vitest";
import { analyzeRisk } from "../src/services/intent.js";

describe("Risk Analysis (Heuristic)", () => {
  it("should classify docs as low risk", () => {
    const result = analyzeRisk({
      intent: "Update README",
      files: [{ path: "docs/readme.md", action: "modify" }],
    });
    expect(result.riskLevel).toBe("low");
    expect(result.summary).toBeTruthy();
  });

  it("should classify auth changes as high risk", () => {
    const result = analyzeRisk({
      intent: "Fix auth bug",
      files: [
        { path: "src/auth/middleware.ts", action: "modify" },
        { path: "src/auth/tokens.ts", action: "modify" },
      ],
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should classify migration files as critical risk", () => {
    const result = analyzeRisk({
      intent: "Add migration for user table",
      files: [{ path: "migrations/001_users.sql", action: "create" }],
    });
    expect(result.riskLevel).toBe("critical");
  });

  it("should classify API/service changes as medium risk", () => {
    const result = analyzeRisk({
      intent: "Add new API endpoint",
      files: [
        { path: "src/routes/users.ts", action: "create" },
        { path: "src/services/users.ts", action: "create" },
      ],
    });
    expect(result.riskLevel).toBe("medium");
  });

  it("should increase risk for many files", () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `components/widget${i}.tsx`,
      action: "create",
    }));
    const result = analyzeRisk({
      intent: "Add widget components",
      files,
    });
    expect(["medium", "high", "critical"]).toContain(result.riskLevel);
  });

  it("should increase risk for deletions", () => {
    const result = analyzeRisk({
      intent: "Remove old utils",
      files: [
        { path: "utils/old-helper.ts", action: "delete" },
      ],
    });
    expect(result.riskLevel).toBe("medium");
  });

  it("should take the higher of provided and computed risk", () => {
    const result = analyzeRisk({
      intent: "Simple doc change",
      files: [{ path: "readme.txt", action: "modify" }],
      existingRiskLevel: "high",
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should use description as summary when available", () => {
    const result = analyzeRisk({
      intent: "Fix bug",
      description: "Fixed the cache invalidation issue in profile updates",
      files: [{ path: "src/cache.ts", action: "modify" }],
    });
    expect(result.summary).toBe(
      "Fixed the cache invalidation issue in profile updates"
    );
  });

  it("should classify Docker/infra changes as high risk", () => {
    const result = analyzeRisk({
      intent: "Update Docker config",
      files: [{ path: "docker-compose.yml", action: "modify" }],
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should classify .env as critical", () => {
    const result = analyzeRisk({
      intent: "Add env var",
      files: [{ path: ".env.production", action: "modify" }],
    });
    expect(result.riskLevel).toBe("critical");
  });
});
