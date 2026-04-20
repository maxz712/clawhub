import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createPlaygroundRoutes } from "../src/routes/playground.js";

function app() {
  const a = new Hono();
  a.route("/api/v1/playground", createPlaygroundRoutes());
  return a;
}

describe("playground", () => {
  it("parses trailers", async () => {
    const res = await app().request("/api/v1/playground/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commitMessage: "Fix bug\n\nIntent: Fix stale cache\nRisk: low\nReview-Focus: src/a.ts:10-12 — hot path\n" }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.parsed.intent).toBe("Fix stale cache");
    expect(j.parsed.risk).toBe("low");
    expect(j.parsed.reviewFocus[0]).toEqual({ path: "src/a.ts", startLine: 10, endLine: 12, note: "hot path" });
  });

  it("renders focused diff from trailers", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,3 @@
 context
-old
+new
@@ -100,3 +100,3 @@
 context2
-old2
+new2`;
    const res = await app().request("/api/v1/playground/focused-diff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commitMessage: "fix\n\nReview-Focus: src/a.ts:10-12\n",
        diff,
      }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.focused).toContain("### src/a.ts");
    expect(j.focused).toContain("-old");
    expect(j.focused).not.toContain("-old2");
  });
});
