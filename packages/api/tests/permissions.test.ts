import { describe, it, expect } from "vitest";
import { evaluatePermissions, evaluateReviewPermissions } from "../src/services/permissions.js";
import type { PermissionRule } from "../src/models/schema.js";

function makeRule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: crypto.randomUUID(),
    repoId: crypto.randomUUID(),
    agentId: null,
    ruleType: "allow_path",
    pattern: "**",
    conditions: null,
    ...overrides,
  };
}

describe("Permission Evaluation Engine", () => {
  it("should allow all files by default when no rules match", () => {
    const result = evaluatePermissions([], "agent-1", ["src/index.ts"], ["create"]);
    expect(result.allowed).toBe(true);
    expect(result.deniedPaths).toEqual([]);
    expect(result.matchedRules).toEqual([]);
  });

  it("should deny access for deny_path rules", () => {
    const rules = [
      makeRule({ ruleType: "deny_path", pattern: "src/auth/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["src/auth/middleware.ts"],
      ["modify"]
    );
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("src/auth/middleware.ts");
  });

  it("should allow access for allow_path rules", () => {
    const rules = [
      makeRule({ ruleType: "allow_path", pattern: "docs/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["docs/readme.md"],
      ["modify"]
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedRules.length).toBe(1);
    expect(result.matchedRules[0].ruleType).toBe("allow_path");
  });

  it("should deny even if allow_path matches other files", () => {
    const rules = [
      makeRule({ ruleType: "allow_path", pattern: "docs/**" }),
      makeRule({ ruleType: "deny_path", pattern: "src/auth/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["docs/readme.md", "src/auth/secret.ts"],
      ["modify", "modify"]
    );
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("src/auth/secret.ts");
  });

  it("should filter rules by agent_id", () => {
    const agentA = "agent-a";
    const agentB = "agent-b";
    const rules = [
      makeRule({
        ruleType: "deny_path",
        pattern: "src/**",
        agentId: agentB,
      }),
    ];
    // Agent A should not be affected
    const resultA = evaluatePermissions(
      rules,
      agentA,
      ["src/index.ts"],
      ["modify"]
    );
    expect(resultA.allowed).toBe(true);

    // Agent B should be denied
    const resultB = evaluatePermissions(
      rules,
      agentB,
      ["src/index.ts"],
      ["modify"]
    );
    expect(resultB.allowed).toBe(false);
  });

  it("should apply null agentId rules to all agents", () => {
    const rules = [
      makeRule({ ruleType: "deny_path", pattern: "*.env", agentId: null }),
    ];
    const result = evaluatePermissions(
      rules,
      "any-agent",
      [".env"],
      ["create"]
    );
    expect(result.allowed).toBe(false);
  });

  it("should not have requiresApproval or autoMerge in result", () => {
    const result = evaluatePermissions([], "agent-1", ["src/index.ts"], ["create"]);
    expect((result as any).requiresApproval).toBeUndefined();
    expect((result as any).autoMerge).toBeUndefined();
  });

  it("should return matched rules in result", () => {
    const rules = [
      makeRule({ ruleType: "allow_path", pattern: "src/**" }),
      makeRule({ ruleType: "deny_path", pattern: "src/secret/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["src/index.ts"],
      ["modify"]
    );
    expect(result.matchedRules.length).toBe(1);
    expect(result.matchedRules[0].ruleType).toBe("allow_path");
  });
});

describe("Review Permission Evaluation", () => {
  it("should allow review by default when no rules match", () => {
    const result = evaluateReviewPermissions([], "agent-1", ["src/index.ts"]);
    expect(result.allowed).toBe(true);
  });

  it("should deny review for deny_review rules", () => {
    const rules = [
      makeRule({ ruleType: "deny_review", pattern: "src/auth/**" }),
    ];
    const result = evaluateReviewPermissions(
      rules,
      "agent-1",
      ["src/auth/middleware.ts"]
    );
    expect(result.allowed).toBe(false);
    expect(result.deniedPaths).toContain("src/auth/middleware.ts");
  });

  it("should allow review for allow_review rules", () => {
    const rules = [
      makeRule({ ruleType: "allow_review", pattern: "docs/**" }),
    ];
    const result = evaluateReviewPermissions(
      rules,
      "agent-1",
      ["docs/readme.md"]
    );
    expect(result.allowed).toBe(true);
    expect(result.matchedRules.length).toBe(1);
  });
});
