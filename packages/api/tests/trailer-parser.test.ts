import { describe, it, expect } from "vitest";
import { parseTrailers, parseFocusLine } from "../src/services/trailer-parser.js";

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
});
