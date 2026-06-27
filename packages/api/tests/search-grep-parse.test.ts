import { describe, it, expect } from "vitest";
import { parseGrepLine } from "../src/services/search.js";

// Regression: code search ran `git grep --heading <rev>`, which prints the
// filename on its own line (`<rev>:<file>` then `<line>:<content>`). The parser
// expected `path:line:content` on ONE line, so it matched NOTHING — code search
// silently returned [] for every repo. Fixed by dropping --heading (output is
// `<rev>:<file>:<line>:<content>`) and stripping the rev prefix.
describe("parseGrepLine", () => {
  it("parses `<rev>:<file>:<line>:<content>` and strips the rev prefix", () => {
    expect(parseGrepLine("main:app.js:1:export function greet(name) {", "main"))
      .toEqual({ path: "app.js", line: 1, content: "export function greet(name) {" });
  });

  it("handles nested paths and content that contains colons", () => {
    expect(parseGrepLine("main:src/db/conn.ts:42:const url = `postgres://x`;", "main"))
      .toEqual({ path: "src/db/conn.ts", line: 42, content: "const url = `postgres://x`;" });
  });

  it("handles a slash-containing default branch name", () => {
    expect(parseGrepLine("release/v2:lib/a.js:7:foo();", "release/v2"))
      .toEqual({ path: "lib/a.js", line: 7, content: "foo();" });
  });

  it("returns null for a bare `--heading` filename line (the old broken format)", () => {
    // `main:app.js` with no line:content — the heading line that broke parsing.
    expect(parseGrepLine("main:app.js", "main")).toBeNull();
  });

  it("returns null for blank/garbage lines", () => {
    expect(parseGrepLine("", "main")).toBeNull();
    expect(parseGrepLine("not a grep line", "main")).toBeNull();
  });
});
