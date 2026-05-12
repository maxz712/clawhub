import { describe, it, expect } from "vitest";
import { parseMagicRef } from "../src/services/ref-rewriter.js";

describe("parseMagicRef", () => {
  it("recognizes refs/for/<branch>", () => {
    expect(parseMagicRef("refs/for/main")).toEqual({ target: "main" });
    expect(parseMagicRef("refs/for/feature/x")).toEqual({ target: "feature/x" });
  });

  it("recognizes refs/clawhub/for/<branch>", () => {
    expect(parseMagicRef("refs/clawhub/for/main")).toEqual({ target: "main" });
  });

  it("ignores direct push refs", () => {
    expect(parseMagicRef("refs/heads/main")).toBeNull();
    expect(parseMagicRef("refs/tags/v1")).toBeNull();
    expect(parseMagicRef("refs/clawhub/changes/abc")).toBeNull();
  });

  it("rejects empty target", () => {
    expect(parseMagicRef("refs/for/")).toBeNull();
  });
});
