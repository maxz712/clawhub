import { describe, it, expect } from "vitest";
import { classifySpec, MIN_DESCRIPTION_SPEC_CHARS } from "../src/services/spec-resolver.js";

describe("classifySpec", () => {
  it("prefers a linked issue (highest authority)", () => {
    const r = classifySpec({ issueText: "Add refund flow\n\nUsers must be able to refund an order.", description: "whatever", intent: "x", branch: "feat/refund" });
    expect(r.basis).toBe("issue");
    expect(r.spec).toMatch(/refund/);
    expect(r.excerpt).toMatch(/refund/);
  });

  it("uses the description when the intent differs from the branch name", () => {
    const r = classifySpec({ intent: "Add a retry with exponential backoff to the webhook sender", branch: "fix/webhooks", description: "" });
    expect(r.basis).toBe("description");
    expect(r.spec).toMatch(/backoff/);
  });

  it("uses the description when the prose is long enough even if intent≈branch", () => {
    const longDesc = "x".repeat(MIN_DESCRIPTION_SPEC_CHARS + 5);
    const r = classifySpec({ intent: "fix webhooks", branch: "fix-webhooks", description: longDesc });
    expect(r.basis).toBe("description");
  });

  it("falls back to inferred when intent≈branch and there's no real prose", () => {
    const r = classifySpec({ intent: "fix webhooks", branch: "fix-webhooks", description: "" });
    expect(r.basis).toBe("inferred");
    expect(r.spec).toBe("");
    expect(r.excerpt).toBe("");
  });

  it("treats a trivial intent equal to the branch as inferred", () => {
    const r = classifySpec({ intent: "update-readme", branch: "update-readme" });
    expect(r.basis).toBe("inferred");
  });
});
