import { describe, it, expect } from "vitest";
import { synthesizeReviewBrief, pathSensitivity, isSensitivePath } from "../src/services/focus-synthesis.js";

describe("pathSensitivity", () => {
  it("floors deploy/CI/policy/migration paths high", () => {
    expect(pathSensitivity("scripts/self-deploy.sh")).toBe("high");
    expect(pathSensitivity("packages/api/drizzle/0040_x.sql")).toBe("high");
    expect(pathSensitivity("packages/api/src/middleware/auth.ts")).toBe("high");
    expect(pathSensitivity(".clawhub/policies/merge.yml")).toBe("high");
  });
  it("floors build/deploy/dependency paths medium", () => {
    expect(pathSensitivity("package.json")).toBe("medium");
    expect(pathSensitivity("deploy/helm/values.yaml")).toBe("medium"); // deploy/** is a MEDIUM floor
    expect(pathSensitivity("packages/api/Dockerfile")).toBe("medium"); // **/Dockerfile is MEDIUM
  });
  it("plain source is not sensitive", () => {
    expect(pathSensitivity("packages/api/src/services/foo.ts")).toBe("none");
    expect(isSensitivePath("packages/api/src/services/foo.ts")).toBe(false);
    expect(isSensitivePath("scripts/deploy.sh")).toBe(true);
  });
});

describe("synthesizeReviewBrief", () => {
  it("kills the empty-focus state: a trailer-less sensitive push gets derived focus", () => {
    const brief = synthesizeReviewBrief({
      files: [{ path: "scripts/deploy.sh", additions: 10, deletions: 2 }],
      sensitiveHunks: [{ path: "scripts/deploy.sh", startLine: 5, endLine: 14 }],
    });
    expect(brief.derivedFocus).toHaveLength(1);
    expect(brief.derivedFocus[0]).toMatchObject({ path: "scripts/deploy.sh", startLine: 5, endLine: 14, source: "sensitive" });
    expect(brief.derivedFocus[0].reason).toMatch(/sensitive path/);
  });

  it("ranks files by churn × sensitivity and demotes generated files", () => {
    const brief = synthesizeReviewBrief({
      files: [
        { path: "package-lock.json", additions: 5000, deletions: 100 }, // generated, huge churn
        { path: "src/small.ts", additions: 3, deletions: 1 },           // tiny source
        { path: "scripts/deploy.sh", additions: 20, deletions: 5 },     // high sensitivity, medium churn
      ],
      sensitiveHunks: [],
    });
    // Sensitive file with real churn ranks first; the giant lockfile is demoted last.
    expect(brief.files[0].path).toBe("scripts/deploy.sh");
    expect(brief.files[brief.files.length - 1].path).toBe("package-lock.json");
    expect(brief.files.find(f => f.path === "package-lock.json")!.generated).toBe(true);
  });

  it("emits a rollback callout when a prior rollback overlaps the changed paths", () => {
    const brief = synthesizeReviewBrief({
      files: [{ path: "src/pay.ts", additions: 4, deletions: 0 }],
      sensitiveHunks: [],
      rollbackEpisodes: [{ paths: ["src/pay.ts", "src/other.ts"], intent: "add refunds", reason: "double charge" }],
    });
    expect(brief.callouts).toHaveLength(1);
    expect(brief.callouts[0].source).toBe("rollback");
    expect(brief.callouts[0].paths).toContain("src/pay.ts");
    expect(brief.callouts[0].message).toMatch(/rolled back/);
  });

  it("does not emit a rollback callout when paths do not overlap", () => {
    const brief = synthesizeReviewBrief({
      files: [{ path: "src/a.ts", additions: 1, deletions: 0 }],
      sensitiveHunks: [],
      rollbackEpisodes: [{ paths: ["src/unrelated.ts"], intent: "x" }],
    });
    expect(brief.callouts).toHaveLength(0);
  });

  it("caps derived focus at 20 flags, high sensitivity first", () => {
    const hunks = Array.from({ length: 30 }, (_, i) => ({ path: "package.json", startLine: i * 2 + 1, endLine: i * 2 + 1 }));
    hunks.push({ path: "scripts/deploy.sh", startLine: 999, endLine: 999 }); // high — must survive the cap
    const brief = synthesizeReviewBrief({
      files: [{ path: "package.json", additions: 60, deletions: 0 }, { path: "scripts/deploy.sh", additions: 1, deletions: 0 }],
      sensitiveHunks: hunks,
    });
    expect(brief.derivedFocus.length).toBeLessThanOrEqual(20);
    // The single HIGH hunk beats MEDIUM hunks for a slot.
    expect(brief.derivedFocus.some(f => f.path === "scripts/deploy.sh")).toBe(true);
  });

  it("is idempotent — same input yields identical output", () => {
    const input = {
      files: [{ path: "b.ts", additions: 2, deletions: 0 }, { path: "a.ts", additions: 2, deletions: 0 }],
      sensitiveHunks: [{ path: "scripts/x.sh", startLine: 1, endLine: 3 }],
    };
    expect(synthesizeReviewBrief(input)).toEqual(synthesizeReviewBrief(input));
  });

  it("emits a cochange callout when a companion file is absent", () => {
    const brief = synthesizeReviewBrief({
      files: [{ path: "src/api.ts", additions: 3, deletions: 0 }],
      sensitiveHunks: [],
      cochangeGaps: [{ absent: "src/api.test.ts", alongside: "src/api.ts" }],
    });
    expect(brief.callouts.some(c => c.source === "cochange")).toBe(true);
  });
});
