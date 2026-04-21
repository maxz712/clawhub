import { describe, it, expect } from "vitest";
import { canonicalAttestation, hashPrompt } from "../src/services/provenance.js";

describe("provenance canonical", () => {
  it("hashes prompts deterministically", () => {
    expect(hashPrompt("hello world")).toBe(hashPrompt("hello world"));
    expect(hashPrompt("a")).not.toBe(hashPrompt("b"));
  });

  it("canonical form is key-order-independent", () => {
    const a = canonicalAttestation({
      repoId: "r1", commitSha: "c1", agentId: "a1",
      toolsUsed: ["grep", "edit"], testsRun: true, typechecked: true,
      extra: { foo: 1 },
    });
    const b = canonicalAttestation({
      agentId: "a1", commitSha: "c1", repoId: "r1",
      extra: { foo: 1 }, typechecked: true, testsRun: true,
      toolsUsed: ["grep", "edit"],
    });
    expect(a).toBe(b);
  });
});
