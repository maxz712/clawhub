import { describe, it, expect } from "vitest";
import { evaluatePermissions } from "../src/services/permissions.js";
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
  it("should allow all files by default with require_approval when no rules", () => {
    const result = evaluatePermissions([], "agent-1", ["src/index.ts"], ["create"]);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.autoMerge).toBe(false);
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

  it("should allow auto_merge for matching patterns", () => {
    const rules = [
      makeRule({ ruleType: "auto_merge", pattern: "docs/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["docs/readme.md"],
      ["modify"]
    );
    expect(result.allowed).toBe(true);
    expect(result.autoMerge).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("should require approval when require_approval rule matches", () => {
    const rules = [
      makeRule({ ruleType: "require_approval", pattern: "src/api/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["src/api/routes.ts"],
      ["modify"]
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.autoMerge).toBe(false);
  });

  it("should override auto_merge with require_approval", () => {
    const rules = [
      makeRule({ ruleType: "auto_merge", pattern: "**" }),
      makeRule({ ruleType: "require_approval", pattern: "src/api/**" }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["src/api/routes.ts"],
      ["modify"]
    );
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.autoMerge).toBe(false);
  });

  it("should deny even if auto_merge matches other files", () => {
    const rules = [
      makeRule({ ruleType: "auto_merge", pattern: "docs/**" }),
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

  it("should enforce max_files condition", () => {
    const rules = [
      makeRule({
        ruleType: "auto_merge",
        pattern: "**",
        conditions: { max_files: 3 },
      }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["a.ts", "b.ts", "c.ts", "d.ts"],
      ["create", "create", "create", "create"]
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.autoMerge).toBe(false);
  });

  it("should enforce no_deletions condition", () => {
    const rules = [
      makeRule({
        ruleType: "auto_merge",
        pattern: "**",
        conditions: { no_deletions: true },
      }),
    ];
    const result = evaluatePermissions(
      rules,
      "agent-1",
      ["old-file.ts"],
      ["delete"]
    );
    expect(result.requiresApproval).toBe(true);
    expect(result.autoMerge).toBe(false);
  });
});
