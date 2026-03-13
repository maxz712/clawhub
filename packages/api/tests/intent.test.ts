import { describe, it, expect } from "vitest";
import { IntentEngine } from "../src/services/intent.js";

describe("Intent Engine (Heuristic Fallback)", () => {
  const engine = new IntentEngine({ apiKey: undefined });

  it("should classify docs as low risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Update README",
      files: [{ path: "docs/readme.md", action: "modify" }],
    });
    expect(result.riskLevel).toBe("low");
    expect(result.summary).toBeTruthy();
  });

  it("should classify auth changes as high risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Fix auth bug",
      files: [
        { path: "src/auth/middleware.ts", action: "modify" },
        { path: "src/auth/tokens.ts", action: "modify" },
      ],
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should classify migration files as critical risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Add migration for user table",
      files: [{ path: "migrations/001_users.sql", action: "create" }],
    });
    expect(result.riskLevel).toBe("critical");
  });

  it("should classify API/service changes as medium risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Add new API endpoint",
      files: [
        { path: "src/routes/users.ts", action: "create" },
        { path: "src/services/users.ts", action: "create" },
      ],
    });
    expect(result.riskLevel).toBe("medium");
  });

  it("should increase risk for many files", async () => {
    const files = Array.from({ length: 12 }, (_, i) => ({
      path: `components/widget${i}.tsx`,
      action: "create",
    }));
    const result = await engine.analyzeChange({
      intent: "Add widget components",
      files,
    });
    expect(["medium", "high", "critical"]).toContain(result.riskLevel);
  });

  it("should increase risk for deletions", async () => {
    const result = await engine.analyzeChange({
      intent: "Remove old utils",
      files: [
        { path: "utils/old-helper.ts", action: "delete" },
      ],
    });
    expect(result.riskLevel).toBe("medium");
  });

  it("should take the higher of provided and computed risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Simple doc change",
      files: [{ path: "readme.txt", action: "modify" }],
      existingRiskLevel: "high",
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should use description as summary when available", async () => {
    const result = await engine.analyzeChange({
      intent: "Fix bug",
      description: "Fixed the cache invalidation issue in profile updates",
      files: [{ path: "src/cache.ts", action: "modify" }],
    });
    expect(result.summary).toBe(
      "Fixed the cache invalidation issue in profile updates"
    );
  });

  it("should classify Docker/infra changes as high risk", async () => {
    const result = await engine.analyzeChange({
      intent: "Update Docker config",
      files: [{ path: "docker-compose.yml", action: "modify" }],
    });
    expect(result.riskLevel).toBe("high");
  });

  it("should classify .env as critical", async () => {
    const result = await engine.analyzeChange({
      intent: "Add env var",
      files: [{ path: ".env.production", action: "modify" }],
    });
    expect(result.riskLevel).toBe("critical");
  });
});
