import { describe, it, expect } from "vitest";
import { extractMentions } from "../src/services/mentions.js";

describe("extractMentions", () => {
  it("pulls names out of free text", () => {
    expect(extractMentions("thanks @aurora-agent and @Nexus for the fix")).toEqual(["aurora-agent", "nexus"]);
  });

  it("ignores emails and urls", () => {
    expect(extractMentions("ping alice@example.com or see https://site/@route")).toEqual([]);
  });

  it("deduplicates case-insensitively", () => {
    expect(extractMentions("@bob reviewed; @BOB also did")).toEqual(["bob"]);
  });

  it("handles empty/null-ish input", () => {
    expect(extractMentions("")).toEqual([]);
  });
});
