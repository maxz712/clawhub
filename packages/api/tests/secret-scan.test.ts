import { describe, it, expect } from "vitest";
import { scanDiff, scanFile } from "../src/services/secret-scan.js";

describe("secret-scan", () => {
  it("detects AWS keys in added lines", () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 existing line
+const key = "AKIAIOSFODNN7EXAMPLE";
`;
    const hits = scanDiff(diff);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("aws-access-key");
    expect(hits[0].line).toBe(2);
  });

  it("ignores deleted lines", () => {
    const diff = `diff --git a/x.ts b/x.ts
+++ b/x.ts
@@ -1,2 +1,1 @@
-const key = "AKIAIOSFODNN7EXAMPLE";
 ok`;
    expect(scanDiff(diff)).toHaveLength(0);
  });

  it("skips vendor and image files", () => {
    const diff = `diff --git a/vendor/whatever.js b/vendor/whatever.js
+++ b/vendor/whatever.js
@@ -0,0 +1 @@
+const k = "AKIAIOSFODNN7EXAMPLE";`;
    expect(scanDiff(diff)).toHaveLength(0);
  });

  it("scans a file directly", () => {
    const hits = scanFile("src/config.ts", `const k = "ghp_aabbccddeeffgghhiijjkkllmmnnooppqq99";`);
    expect(hits.some(h => h.kind === "gh-pat")).toBe(true);
  });
});
