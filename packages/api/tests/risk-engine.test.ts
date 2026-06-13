import { describe, it, expect } from "vitest";
import { computeRisk, type RiskInput } from "../src/services/risk-engine.js";

const base: RiskInput = {
  declared: "low",
  changedPaths: [],
  additions: 0,
  deletions: 0,
  agentPriorRollbacks: 0,
};

describe("computeRisk", () => {
  it("floors migrations to high", () => {
    const r = computeRisk({ ...base, changedPaths: ["packages/api/migrations/0001_init.sql", "packages/api/migrations/0001_init.sql.test.ts"] });
    expect(r.risk).toBe("high");
    expect(r.reasons.some(x => /sensitive paths/.test(x))).toBe(true);
  });

  it("floors auth/security/payments/billing/policies to high", () => {
    for (const p of [
      "packages/api/src/auth/login.ts",
      "packages/api/src/security/scan.ts",
      "src/payments/charge.go",
      "src/billing/invoice.py",
      ".clawhub/policies/merge.yml",
      "packages/api/src/middleware/auth.ts",
    ]) {
      // Pair each sensitive path with a matching test path so the no-test bump
      // doesn't muddy the assertion that the *floor* is high.
      const r = computeRisk({ ...base, changedPaths: [p, "tests/x.test.ts"] });
      expect(r.risk, p).toBe("high");
    }
  });

  it("floors deploy/docker/ci/package.json to medium", () => {
    for (const p of ["deploy/helm/values.yaml", "Dockerfile", "docker-compose.yml", ".github/workflows/ci.yml", "package.json", "main.tf"]) {
      const r = computeRisk({ ...base, changedPaths: [p] });
      expect(r.risk, p).toBe("medium");
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it("bumps one tier for a large change over 400 lines", () => {
    const r = computeRisk({ ...base, changedPaths: ["deploy/x.yaml"], additions: 300, deletions: 150 });
    // medium floor + size bump → high
    expect(r.risk).toBe("high");
    expect(r.reasons.some(x => /large change: 450 lines/.test(x))).toBe(true);
  });

  it("floors very large changes over 1500 lines to high", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/readme.md"], additions: 1600, deletions: 0 });
    expect(r.risk).toBe("high");
    expect(r.reasons.some(x => /very large change: 1600 lines/.test(x))).toBe(true);
  });

  it("floors mass deletion to medium", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/legacy.md"], additions: 10, deletions: 250 });
    expect(r.risk).toBe("medium");
    expect(r.reasons.some(x => /mass deletion: 250 lines removed/.test(x))).toBe(true);
  });

  it("bumps when source changes without test changes", () => {
    const r = computeRisk({ ...base, changedPaths: ["src/feature.ts"] });
    expect(r.risk).toBe("medium");
    expect(r.reasons.some(x => /code changed without test changes/.test(x))).toBe(true);
  });

  it("does not bump for no-test when a test file is present", () => {
    const r = computeRisk({ ...base, changedPaths: ["src/feature.ts", "src/feature.test.ts"] });
    expect(r.risk).toBe("low");
    expect(r.reasons.some(x => /without test changes/.test(x))).toBe(false);
  });

  it("caps the no-test bump at high", () => {
    // medium floor (middleware path) + no-test bump on a source file → high,
    // and never higher.
    const r = computeRisk({ ...base, changedPaths: ["packages/api/src/middleware/cors.ts"] });
    expect(r.risk).toBe("high");
    expect(r.reasons.some(x => /code changed without test changes/.test(x))).toBe(true);
  });

  it("bumps one tier when the author has prior rollbacks", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/x.md"], agentPriorRollbacks: 2 });
    expect(r.risk).toBe("medium");
    expect(r.reasons.some(x => /author agent has 2 rolled-back changes in this repo/.test(x))).toBe(true);
  });

  it("singularizes the rollback reason for exactly one", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/x.md"], agentPriorRollbacks: 1 });
    expect(r.reasons.some(x => /author agent has 1 rolled-back change in this repo/.test(x))).toBe(true);
  });

  it("takes the declared risk when it exceeds computed", () => {
    const r = computeRisk({ ...base, declared: "critical", changedPaths: ["docs/x.md"] });
    expect(r.risk).toBe("critical");
    expect(r.reasons.some(x => /agent-declared risk: critical/.test(x))).toBe(true);
  });

  it("ignores declared risk lower than computed (floors win)", () => {
    const r = computeRisk({ ...base, declared: "low", changedPaths: ["src/auth/x.ts", "tests/x.test.ts"] });
    expect(r.risk).toBe("high");
    expect(r.reasons.some(x => /agent-declared/.test(x))).toBe(false);
  });

  it("returns non-empty reasons whenever risk is raised, naming the triggers", () => {
    const r = computeRisk({ declared: "low", changedPaths: ["packages/api/migrations/x.sql"], additions: 500, deletions: 0, agentPriorRollbacks: 1 });
    expect(r.risk).toBe("high");
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.some(x => /sensitive paths/.test(x))).toBe(true);
    expect(r.reasons.some(x => /large change/.test(x))).toBe(true);
    expect(r.reasons.some(x => /rolled-back/.test(x))).toBe(true);
  });

  it("leaves a trivial change at low with no reasons", () => {
    const r = computeRisk({ ...base, changedPaths: ["README.md"], additions: 3, deletions: 1 });
    expect(r.risk).toBe("low");
    expect(r.reasons).toEqual([]);
  });
});
