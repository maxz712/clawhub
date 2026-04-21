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
