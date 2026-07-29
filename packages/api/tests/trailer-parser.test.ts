import { describe, it, expect } from "vitest";
import { parseTrailers, parseFocusLine, stripTrailerBlock, describeCommits } from "../src/services/trailer-parser.js";

describe("parseTrailers", () => {
  it("extracts canonical trailers from a commit message", () => {
    const msg = `Fix stale cache

Longer description

Intent: Fix stale cache bug
Risk: low
Scope: src/api/profile.ts, tests/api/profile.test.ts
Review-Focus: src/api/profile.ts:47-52 — new cache invalidation
Closes: #142
Agent: felix-openclaw`;
    const t = parseTrailers(msg);
    expect(t.intent).toBe("Fix stale cache bug");
    expect(t.risk).toBe("low");
    expect(t.scope).toEqual(["src/api/profile.ts", "tests/api/profile.test.ts"]);
    expect(t.reviewFocus).toEqual([{ path: "src/api/profile.ts", startLine: 47, endLine: 52, note: "new cache invalidation" }]);
    expect(t.closes).toEqual([142]);
    expect(t.agent).toBe("felix-openclaw");
  });

  it("falls back to subject when Intent is missing", () => {
    const t = parseTrailers("Add new endpoint\n\nbody text");
    expect(t.intent).toBe("Add new endpoint");
  });

  it("ignores invalid risk values", () => {
    const t = parseTrailers("x\n\nRisk: apocalyptic");
    expect(t.risk).toBeUndefined();
  });

  it("supports multiple Review-Focus lines and Closes refs", () => {
    const t = parseTrailers("x\n\nReview-Focus: a.ts:1-2\nReview-Focus: b.ts:10\nCloses: #1\nCloses: #2 #3");
    expect(t.reviewFocus).toHaveLength(2);
    expect(t.closes.sort()).toEqual([1, 2, 3]);
  });

  it("parses Draft: true/false and leaves it undefined when the trailer is absent", () => {
    expect(parseTrailers("x\n\nDraft: true").draft).toBe(true);
    expect(parseTrailers("x\n\nDraft: WIP").draft).toBe(true);
    expect(parseTrailers("x\n\nDraft: false").draft).toBe(false);
    expect(parseTrailers("x\n\nDraft: no").draft).toBe(false);
    expect(parseTrailers("x\n\nIntent: ship it").draft).toBeUndefined();
  });
});

describe("parseFocusLine", () => {
  it("parses path:line format", () => {
    expect(parseFocusLine("src/foo.ts:10")).toEqual([{ path: "src/foo.ts", startLine: 10, endLine: 10, note: undefined }]);
  });
  it("parses path:start-end with note", () => {
    expect(parseFocusLine("a.ts:1-5 — reason")).toEqual([{ path: "a.ts", startLine: 1, endLine: 5, note: "reason" }]);
  });
  it("normalizes a transposed range so startLine <= endLine", () => {
    // Without normalization the diff renderer's `newNo >= startLine && newNo <= endLine`
    // matches no lines and the focus silently disappears.
    expect(parseFocusLine("a.ts:52-47")).toEqual([{ path: "a.ts", startLine: 47, endLine: 52, note: undefined }]);
    expect(parseFocusLine("a.ts:52-47 — reversed")).toEqual([{ path: "a.ts", startLine: 47, endLine: 52, note: "reversed" }]);
  });
});

describe("stripTrailerBlock", () => {
  it("drops the subject and the trailing trailer block", () => {
    const msg = "Add refunds\n\nThis reworks the payment flow to allow partial refunds.\n\nIntent: refunds\nRisk: high\nCloses: #4";
    expect(stripTrailerBlock(msg)).toBe("This reworks the payment flow to allow partial refunds.");
  });
  it("keeps a mid-body line that merely looks like a trailer", () => {
    const msg = "Subject\n\nNote: this is important prose, not a trailer.\nMore prose.\n\nRisk: low";
    const out = stripTrailerBlock(msg);
    expect(out).toContain("Note: this is important prose");
    expect(out).toContain("More prose.");
    expect(out).not.toContain("Risk: low");
  });
  it("returns empty when there is only a subject + trailers", () => {
    expect(stripTrailerBlock("Subject only\n\nIntent: x\nRisk: low")).toBe("");
  });
});

describe("describeCommits", () => {
  it("aggregates non-empty commit bodies, dedupes, and caps", () => {
    const out = describeCommits([
      { message: "A\n\nBody of A.\n\nRisk: low" },
      { message: "B\n\nBody of B." },
      { message: "C\n\nBody of A." }, // duplicate prose deduped
    ]);
    expect(out).toBe("Body of A.\n\nBody of B.");
  });
  it("returns null when no commit has prose", () => {
    expect(describeCommits([{ message: "Subject\n\nRisk: low" }])).toBeNull();
  });
  it("caps at the byte limit with an ellipsis", () => {
    const big = "x".repeat(20000);
    const out = describeCommits([{ message: `Subj\n\n${big}` }], 100);
    expect(out!.length).toBe(100);
    expect(out!.endsWith("…")).toBe(true);
  });
});
