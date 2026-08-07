import { describe, it, expect } from "vitest";
import { scanDiff, scanFile, scanPushedFiles, isScannablePath } from "../src/services/secret-scan.js";

const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // AWS's documented example, exactly 40 chars

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

  // #130 leg 3 — the pattern was case-SENSITIVE, so the canonical way an AWS
  // secret reaches git (the uppercase env-var name, in a .env or CI config)
  // passed clean unless the AKIA… id happened to be committed beside it.
  describe("aws-secret-key is case-insensitive", () => {
    for (const line of [
      `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
      `AWS_SECRET_ACCESS_KEY: ${AWS_SECRET}`,
      `  aws_secret_access_key = ${AWS_SECRET}`,
      `Aws_Secret_Access_Key="${AWS_SECRET}"`,
    ]) {
      it(`flags ${line.trim().slice(0, 28)}…`, () => {
        expect(scanFile(".env", line).map(h => h.kind)).toContain("aws-secret-key");
      });
    }

    it("does not flag a longer base64 blob on an aws-mentioning line", () => {
      // An npm `integrity` sha512 is 88 base64 chars; before the length boundary
      // the pattern matched a 40-char window inside it, which case-insensitivity
      // would have turned into a steady stream of false rejections.
      expect(scanFile("package.json", `"aws-sdk-integrity": "${"A".repeat(88)}"`)).toEqual([]);
    });
  });
});

// #130 legs 1+2 — the push gate's own scanning rules. The path list it is
// HANDED must be git-derived (asserted end-to-end in post-push-secret-scan.test.ts);
// this covers what it does with the list.
describe("scanPushedFiles", () => {
  const contentsOf = (m: Record<string, string>) => new Map(Object.entries(m));

  it("scans every path — no 40-file cap", () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 60; i++) files[`src/f${i}.ts`] = i === 50 ? `const k = "ghp_aabbccddeeffgghhiijjkkllmmnnooppqq99";` : `const n = ${i};`;
    const res = scanPushedFiles(Object.keys(files), contentsOf(files));
    expect(res.hits[0]?.path).toBe("src/f50.ts");
    expect(res.scanned).toBe(50); // stopped AT the hit, having looked past 40
    expect(res.truncated).toBe(false);
  });

  it("reports truncation instead of silently skipping (byte budget)", () => {
    const files = { "a.ts": "x".repeat(100), "b.ts": `const k = "ghp_aabbccddeeffgghhiijjkkllmmnnooppqq99";` };
    const res = scanPushedFiles(Object.keys(files), contentsOf(files), { maxTotalBytes: 100 });
    expect(res.hits).toEqual([]);        // b.ts never reached...
    expect(res.truncated).toBe(true);    // ...and the caller is TOLD so (log + metric)
    expect(res.unscanned).toBe(1);
  });

  it("counts ignored and binary skips rather than hiding them", () => {
    const key = `const k = "ghp_aabbccddeeffgghhiijjkkllmmnnooppqq99";`;
    const res = scanPushedFiles(
      ["logo.png", "tests/fixture.ts", "src/bin.dat", "src/ok.ts"],
      contentsOf({ "logo.png": key, "tests/fixture.ts": key, "src/bin.dat": `\0${key}`, "src/ok.ts": "clean" }),
    );
    expect(res.hits).toEqual([]);
    expect(res.skippedIgnored).toBe(2);
    expect(res.skippedBinary).toBe(1);
    expect(res.scanned).toBe(1);
  });

  it("ignores paths with no blob at the new commit (deletes, the old side of a rename)", () => {
    const res = scanPushedFiles(["gone.ts", "src/ok.ts"], contentsOf({ "src/ok.ts": "clean" }));
    expect(res.scanned).toBe(1);
    expect(res.skippedIgnored + res.skippedBinary).toBe(0);
  });

  it("scans a duplicated path once", () => {
    const res = scanPushedFiles(["src/ok.ts", "src/ok.ts"], contentsOf({ "src/ok.ts": "clean" }));
    expect(res.scanned).toBe(1);
  });

  it("isScannablePath mirrors the ignore rules", () => {
    expect(isScannablePath("src/config.ts")).toBe(true);
    expect(isScannablePath("vendor/x.js")).toBe(false);
    expect(isScannablePath("docs/shot.png")).toBe(false);
  });
});
