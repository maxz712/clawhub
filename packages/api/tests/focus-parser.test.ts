import { describe, it, expect } from "vitest";
import { extractInlineReviewComments, mergeFocus } from "../src/services/focus-parser.js";

describe("extractInlineReviewComments", () => {
  it("finds // REVIEW: comments", () => {
    const src = [
      "function foo() {",
      "  const x = 1; // REVIEW: why inlined?",
      "  return x;",
      "}",
    ].join("\n");
    const out = extractInlineReviewComments("foo.ts", src);
    expect(out).toEqual([{ path: "foo.ts", startLine: 2, endLine: 2, note: "why inlined?" }]);
  });

  it("finds # REVIEW: comments", () => {
    const src = "# REVIEW: check this\nprint('hi')";
    const out = extractInlineReviewComments("x.py", src);
    expect(out[0].note).toBe("check this");
  });
});

describe("mergeFocus", () => {
  it("deduplicates identical ranges across sources", () => {
    const a = [{ path: "a.ts", startLine: 1, endLine: 2 }];
    const b = [{ path: "a.ts", startLine: 1, endLine: 2, note: "dup" }];
    const merged = mergeFocus(a, b);
    expect(merged).toHaveLength(1);
  });
});
