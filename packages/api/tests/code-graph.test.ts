import { describe, expect, it } from "vitest";
import { extractImports, extractSymbols, resolveImportTarget } from "../src/services/code-graph.js";

// v3 P6 — Graphify extraction goldens (pure, per-language).

describe("extractSymbols", () => {
  it("TypeScript: functions, classes, types, exported consts, routes", () => {
    const src = [
      "export async function processPush(db: DB) {}",
      "class MergeWorker {",
      "export interface MergePolicy {",
      "export type Risk = string;",
      "export const BASELINE = [];",
      "const internal = 1;", // not exported → not a symbol
      'app.get("/api/v1/identities", handler);',
    ].join("\n");
    const syms = extractSymbols("src/x.ts", src);
    expect(syms).toContainEqual({ symbol: "processPush", kind: "function", line: 1 });
    expect(syms).toContainEqual({ symbol: "MergeWorker", kind: "class", line: 2 });
    expect(syms).toContainEqual({ symbol: "MergePolicy", kind: "type", line: 3 });
    expect(syms).toContainEqual({ symbol: "Risk", kind: "type", line: 4 });
    expect(syms).toContainEqual({ symbol: "BASELINE", kind: "const", line: 5 });
    expect(syms.find(s => s.symbol === "internal")).toBeUndefined();
    expect(syms).toContainEqual({ symbol: "/api/v1/identities", kind: "route", line: 7 });
  });

  it("Python: defs and classes", () => {
    const syms = extractSymbols("app/main.py", "def handler():\n    pass\nclass Router:\n  async def go(self): ...");
    expect(syms).toContainEqual({ symbol: "handler", kind: "function", line: 1 });
    expect(syms).toContainEqual({ symbol: "Router", kind: "class", line: 3 });
    expect(syms).toContainEqual({ symbol: "go", kind: "function", line: 4 });
  });

  it("Go: funcs (incl. methods) and types", () => {
    const syms = extractSymbols("pkg/s.go", "func Serve() {}\nfunc (s *Shard) Apply() {}\ntype Shard struct {}");
    expect(syms).toContainEqual({ symbol: "Serve", kind: "function", line: 1 });
    expect(syms).toContainEqual({ symbol: "Apply", kind: "function", line: 2 });
    expect(syms).toContainEqual({ symbol: "Shard", kind: "type", line: 3 });
  });

  it("unknown extensions yield nothing", () => {
    expect(extractSymbols("a.rb", "def x; end")).toEqual([]);
  });
});

describe("extractImports + resolveImportTarget", () => {
  it("captures relative TS imports only (package imports skipped)", () => {
    const imps = extractImports("src/services/a.ts", [
      'import { x } from "./b.js";',
      'import fs from "node:fs";',
      'const y = require("../lib/c");',
    ].join("\n"));
    expect(imps.map(i => i.target)).toEqual(["./b.js", "../lib/c"]);
  });

  it("resolves relative targets against the repo file list (ESM .js → .ts)", () => {
    const known = new Set(["src/services/b.ts", "src/lib/c.ts", "src/lib/d/index.ts"]);
    expect(resolveImportTarget("src/services/a.ts", "./b.js", known)).toBe("src/services/b.ts");
    expect(resolveImportTarget("src/services/a.ts", "../lib/c", known)).toBe("src/lib/c.ts");
    expect(resolveImportTarget("src/services/a.ts", "../lib/d", known)).toBe("src/lib/d/index.ts");
    expect(resolveImportTarget("src/services/a.ts", "./missing", known)).toBeNull();
  });
});
