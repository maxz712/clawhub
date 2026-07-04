import { describe, it, expect } from "vitest";
import { computeRisk, isGeneratedFile, type RiskInput } from "../src/services/risk-engine.js";

const base: RiskInput = {
  declared: "low",
  changedPaths: [],
  additions: 0,
  deletions: 0,
  agentPriorRollbacks: 0,
};

describe("computeRisk", () => {
  it("does NOT apply the author-rollback bump to a docs-only change (behaviorally inert stays low)", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/verified-autonomy.md"], additions: 2, deletions: 0, agentPriorRollbacks: 7 });
    expect(r.risk).toBe("low");
    expect(r.reasons.join(" ")).not.toContain("rolled-back");
  });

  it("STILL applies the author-rollback bump to a code change (src + test → isolates the bump)", () => {
    const r = computeRisk({ ...base, changedPaths: ["packages/api/src/services/x.ts", "packages/api/tests/x.test.ts"], additions: 2, deletions: 0, agentPriorRollbacks: 7 });
    expect(r.risk).toBe("medium");
    expect(r.reasons.join(" ")).toContain("rolled-back");
  });

  it("a mixed docs+code change from a flappy author is NOT inert (bump applies)", () => {
    const r = computeRisk({ ...base, changedPaths: ["docs/x.md", "packages/api/src/x.ts", "packages/api/tests/x.test.ts"], additions: 2, deletions: 0, agentPriorRollbacks: 3 });
    expect(r.risk).toBe("medium");
    expect(r.reasons.join(" ")).toContain("rolled-back");
  });

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

  it("bumps one tier when the author has prior rollbacks (on a code change)", () => {
    // src + a test alongside → isolates the author bump from the no-test bump.
    const r = computeRisk({ ...base, changedPaths: ["packages/api/src/x.ts", "packages/api/tests/x.test.ts"], agentPriorRollbacks: 2 });
    expect(r.risk).toBe("medium");
    expect(r.reasons.some(x => /author agent has 2 rolled-back changes in this repo/.test(x))).toBe(true);
  });

  it("singularizes the rollback reason for exactly one", () => {
    const r = computeRisk({ ...base, changedPaths: ["packages/api/src/x.ts", "packages/api/tests/x.test.ts"], agentPriorRollbacks: 1 });
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

  // GAP 1: generated files (lockfiles, snapshots, build output) must not drive
  // risk. The size metric excludes them in post-push.ts before computeRisk; here
  // we assert the path-floor + a lockfile-only change stays low when its lines
  // have been excluded, and that package.json still floors medium.
  describe("generated files do not inflate risk", () => {
    it("a lockfile-only change computes low (size excluded, no medium floor)", () => {
      // post-push excludes the lockfile's lines from the size totals, so the
      // engine sees a 0-line change touching only a lockfile path.
      const r = computeRisk({ ...base, changedPaths: ["package-lock.json"], additions: 0, deletions: 0 });
      expect(r.risk).toBe("low");
      expect(r.reasons).toEqual([]);
    });

    it("a huge lockfile-only change still computes low once its lines are excluded", () => {
      // 1,983-line package-lock.json — the real marketsync case. With its lines
      // subtracted the size heuristic sees 0 lines and the lockfile no longer
      // floors medium, so a normal first commit is not blocked.
      const r = computeRisk({ ...base, changedPaths: ["package-lock.json"], additions: 0, deletions: 0 });
      expect(r.risk).toBe("low");
    });

    it("a package.json change still floors medium (declares deps)", () => {
      const r = computeRisk({ ...base, changedPaths: ["package.json"], additions: 5, deletions: 2 });
      expect(r.risk).toBe("medium");
      expect(r.reasons.some(x => /build\/deploy\/dependency paths/.test(x))).toBe(true);
    });

    it("a nested lockfile no longer floors medium", () => {
      for (const p of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "packages/api/package-lock.json"]) {
        const r = computeRisk({ ...base, changedPaths: [p], additions: 0, deletions: 0 });
        expect(r.risk, p).toBe("low");
      }
    });

    it("a large real-source change still bumps even alongside an excluded lockfile", () => {
      // post-push subtracts the lockfile's lines; the real source lines remain
      // and still drive the size bump. 450 non-generated lines → large change.
      const r = computeRisk({ ...base, changedPaths: ["src/feature.ts", "package-lock.json", "src/feature.test.ts"], additions: 300, deletions: 150 });
      expect(r.risk).toBe("medium");
      expect(r.reasons.some(x => /large change: 450 lines/.test(x))).toBe(true);
    });

    it("a very large real-source change still floors high", () => {
      const r = computeRisk({ ...base, changedPaths: ["src/feature.ts", "src/feature.test.ts"], additions: 1600, deletions: 0 });
      expect(r.risk).toBe("high");
      expect(r.reasons.some(x => /very large change: 1600 lines/.test(x))).toBe(true);
    });
  });

  describe("isGeneratedFile", () => {
    it("flags lockfiles, snapshots, build output, minified bundles", () => {
      for (const p of [
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
        "Cargo.lock", "go.sum", "poetry.lock", "composer.lock",
        "packages/api/package-lock.json", "sub/dir/yarn.lock",
        "src/__snapshots__/x.snap", "test/a.test.ts.snap",
        "dist/index.js", "packages/api/dist/main.js",
        "build/out.js", "web/build/bundle.js",
        "static/app.min.js", "a/b/vendor.min.js",
        "src/__snapshots__/component.test.tsx.snap",
      ]) {
        expect(isGeneratedFile(p), p).toBe(true);
      }
    });

    it("does not flag hand-authored manifest + source files", () => {
      for (const p of [
        "package.json", "packages/api/package.json",
        "src/index.ts", "README.md", "go.mod", "Cargo.toml", "pyproject.toml",
      ]) {
        expect(isGeneratedFile(p), p).toBe(false);
      }
    });
  });

  describe("deploy + CI control-plane floors to high", () => {
    for (const p of ["scripts/self-deploy.sh", "scripts/backup.sh", ".clawhub/ci/deploy.yml", "packages/api/scripts/migrate.sh"]) {
      it(`floors ${p} to high`, () => {
        // Pair with a test path so the no-test bump doesn't muddy the floor.
        const r = computeRisk({ ...base, changedPaths: [p, "tests/x.test.ts"] });
        expect(r.risk, p).toBe("high");
      });
    }
  });
});
