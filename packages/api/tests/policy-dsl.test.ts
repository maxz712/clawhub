import { describe, it, expect } from "vitest";
import { coerceToPolicy, parsePolicyYaml, pathRequiresHuman } from "../src/services/policy-dsl.js";

describe("policy-dsl parser", () => {
  it("parses a simple policy doc", () => {
    const src = `requireHumanApproval: if_risk_at_least
requireHumanApprovalLevel: high
minApprovalsTotal: 2
minApprovalsHuman: 1
allowSelfReview: false
ciRequired: true
trustedAgents:
  - aurora-agent
  - nexus-bot
`;
    const parsed = coerceToPolicy(parsePolicyYaml(src) as Record<string, unknown>);
    expect(parsed.requireHumanApproval).toBe("if_risk_at_least");
    expect(parsed.minApprovalsTotal).toBe(2);
    expect(parsed.ciRequired).toBe(true);
    expect(parsed.trustedAgents).toEqual(["aurora-agent", "nexus-bot"]);
  });

  // #129 — coerceToPolicy used to build a FULL MergePolicy (every absent key
  // defaulted), so the adoption site's write deleted every persisted key the
  // DSL cannot express — requireCiRun, blockAgentDirectDefaultPush, verifyTier,
  // verifiedAutonomy, autoMergeOnVerified — four of them permissive-ward, on
  // every merge.yml adoption.
  it("emits ONLY the keys the YAML names (absent is not 'set to the default')", () => {
    const parsed = coerceToPolicy(parsePolicyYaml("ciRequired: false\nminApprovalsHuman: 2\n") as Record<string, unknown>);
    expect(parsed).toEqual({ ciRequired: false, minApprovalsHuman: 2 });
    expect(coerceToPolicy({})).toEqual({});
  });

  it("overlaying the parsed file onto an existing blob preserves every unexpressible key", () => {
    // The exact merge the adoption site (post-push.ts) performs.
    const existing = {
      requireCiRun: true,
      blockAgentDirectDefaultPush: true,
      sensitiveBaseline: false,
      dismissStaleApprovals: false,
      requireIndependentApprover: true,
      minApprovalsHuman: 1,
      verifyTier: { minVerifyTier: "services", forceTierGlobs: ["deploy/**"], allowDind: false },
      verifiedAutonomy: { enabled: true, maxRisk: "medium", allowSensitivePaths: false, floorGlobs: ["scripts/**"] },
      autoMergeOnVerified: true,
    };
    const overlay = coerceToPolicy(parsePolicyYaml([
      "minApprovalsHuman: 0",
      "requireHumanApprovalLevel: high",
      "allowSelfReview: true",
      "ciRequired: true",
    ].join("\n")) as Record<string, unknown>);
    const merged = { ...existing, ...overlay } as Record<string, unknown>;

    // Named keys still take effect (the file overrides the DB value).
    expect(merged.minApprovalsHuman).toBe(0);
    expect(merged.allowSelfReview).toBe(true);
    expect(merged.requireHumanApprovalLevel).toBe("high");
    expect(merged.ciRequired).toBe(true);
    // Unnamed keys survive — the permissive-ward four AND the fail-safe opt-outs.
    expect(merged.requireCiRun).toBe(true);
    expect(merged.blockAgentDirectDefaultPush).toBe(true);
    expect(merged.verifyTier).toEqual(existing.verifyTier);
    expect(merged.verifiedAutonomy).toEqual(existing.verifiedAutonomy);
    expect(merged.autoMergeOnVerified).toBe(true);
    expect(merged.sensitiveBaseline).toBe(false);
    expect(merged.dismissStaleApprovals).toBe(false);
    expect(merged.requireIndependentApprover).toBe(true);
  });

  it("pathRequiresHuman handles glob overrides", () => {
    const policy = coerceToPolicy({
      pathOverrides: [{ glob: "auth/**", requireHuman: true }],
      requireHumanApproval: "never",
      trustedAgents: [],
      minApprovalsTotal: 0,
      minApprovalsHuman: 0,
      allowSelfReview: true,
      ciRequired: false,
      requireHumanApprovalLevel: "high",
    });
    expect(pathRequiresHuman(policy, ["auth/login.ts"])).toBe(true);
    expect(pathRequiresHuman(policy, ["ui/page.tsx"])).toBe(false);
  });
});
