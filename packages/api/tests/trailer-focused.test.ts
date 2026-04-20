import { describe, it, expect } from "vitest";
import { parseTrailers } from "../src/services/trailer-parser.js";
import { mergeFocus, extractInlineReviewComments } from "../src/services/focus-parser.js";

describe("trailer-focus integration", () => {
  it("combines trailer + inline review comments deduped", () => {
    const parsed = parseTrailers("msg\n\nReview-Focus: src/a.ts:10-12 — note\n");
    const inline = extractInlineReviewComments("src/a.ts", "line1\nline2\n// REVIEW: inline\nline4");
    const merged = mergeFocus(parsed.reviewFocus, inline);
    expect(merged.length).toBeGreaterThanOrEqual(2);
    expect(merged.some(f => f.startLine === 10 && f.endLine === 12)).toBe(true);
    expect(merged.some(f => f.note === "inline")).toBe(true);
  });
});
