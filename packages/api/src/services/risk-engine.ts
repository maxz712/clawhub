import { minimatch } from "minimatch";
import type { Risk } from "./trailer-parser.js";

// Risk is COMPUTED from the diff, never declared away. The engine is fully
// deterministic and explainable — no LLM. Every trigger appends a
// human-readable reason so the dashboard can show *why* a Change is gated.
// Order of operations: floor from path taxonomy → size/heuristic bumps →
// final = max(declared, computed). Floors never lower an already-higher value;
// bumps never exceed critical.

export interface RiskInput {
  declared: Risk;
  changedPaths: string[];
  additions: number;
  deletions: number;
  agentPriorRollbacks: number;
}

export interface RiskAssessment {
  risk: Risk;
  reasons: string[];
}

const ORDER: Risk[] = ["low", "medium", "high", "critical"];
const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// Paths whose mere presence in the diff floors the change at HIGH — security
// surface, money, schema, governance policy. Touching these is never low-risk.
// Exported so focus-synthesis (M1 Review Brief) can flag the same sensitive
// hunks the risk engine floors on — one taxonomy, two consumers.
export const HIGH_FLOOR_GLOBS = [
  "**/auth/**",
  "**/security/**",
  "**/payments/**",
  "**/payment/**",
  "**/billing/**",
  "**/migrations/**",
  "**/*.sql",
  ".clawhub/policies/**",
  // Deploy + CI control plane: these execute code on / reconfigure the host on
  // merge. Kept in lockstep with merge-policy's BASELINE_SENSITIVE_GLOBS so the
  // risk shown matches the human-review the merge gate forces. See the
  // 2026-06-20 security audit (deploy-path-not-sensitive finding).
  "scripts/**",
  "**/scripts/**",
  ".clawhub/ci/**",
  "**/secrets*",
  "**/middleware/auth*",
];

// Paths that floor at MEDIUM — build, deploy, dependency, and request-pipeline
// surface. Riskier than app code, less than the HIGH set.
//
// NOTE: only files that *declare* dependencies floor here (package.json). Pure
// lockfiles (package-lock.json / yarn.lock / pnpm-lock.yaml) are excluded — a
// lockfile is a derived artifact the agent regenerated, not a hand-authored
// dependency decision, so a lockfile-only bump must not floor a solo workflow to
// medium. The declaring manifest still does.
export const MEDIUM_FLOOR_GLOBS = [
  "deploy/**",
  "**/Dockerfile",
  "docker-compose*.yml",
  ".github/**",
  "package.json",
  "**/package.json",
  "**/middleware/**",
  "*.tf",
  "deploy/helm/**",
];

/** True when a path floors the change at HIGH by the risk taxonomy. */
export function isHighSensitivePath(path: string): boolean {
  return matchesAny(path, HIGH_FLOOR_GLOBS);
}

/** True when a path floors the change at MEDIUM by the risk taxonomy. */
export function isMediumSensitivePath(path: string): boolean {
  return matchesAny(path, MEDIUM_FLOOR_GLOBS);
}

// Generated / derived files: lockfiles, snapshots, build output, minified
// bundles. These are machine-produced, not hand-authored, so their (often huge)
// line counts must not drive the SIZE heuristic. The size totals subtract these
// before the size bump/floor (see post-push.ts). They are NOT removed from the
// changedPaths used for path-floor logic — a generated file still living under a
// sensitive path is accounted for there.
export const GENERATED_GLOBS = [
  "package-lock.json",
  "**/package-lock.json",
  "yarn.lock",
  "**/yarn.lock",
  "pnpm-lock.yaml",
  "**/pnpm-lock.yaml",
  "npm-shrinkwrap.json",
  "**/npm-shrinkwrap.json",
  "Cargo.lock",
  "**/Cargo.lock",
  "go.sum",
  "**/go.sum",
  "poetry.lock",
  "**/poetry.lock",
  "composer.lock",
  "**/composer.lock",
  "**/*.snap",
  "dist/**",
  "**/dist/**",
  "build/**",
  "**/build/**",
  "**/*.min.js",
  "**/__snapshots__/**",
];

/** True when a path is a generated/derived artifact (lockfile, snapshot, build
 *  output, minified bundle). Used to exclude such files from the size metric. */
export function isGeneratedFile(path: string): boolean {
  return matchesAny(path, GENERATED_GLOBS);
}

// Source files that should normally arrive with a test change alongside them.
const SOURCE_GLOBS = ["src/**/*", "packages/**/*"];
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".go", ".py"];
const TEST_GLOBS = ["**/*.test.*", "**/*_test.*", "**/tests/**", "**/__tests__/**"];

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(g => minimatch(path, g, { dot: true }));
}

function isSource(path: string): boolean {
  return matchesAny(path, SOURCE_GLOBS) && SOURCE_EXTS.some(ext => path.endsWith(ext));
}

function isTest(path: string): boolean {
  return matchesAny(path, TEST_GLOBS);
}

function bump(risk: Risk, cap: Risk = "critical"): Risk {
  return ORDER[Math.min(RANK[risk] + 1, RANK[cap])];
}

function floor(risk: Risk, to: Risk): Risk {
  // Floors only raise; they never pull an already-higher value down.
  return RANK[to] > RANK[risk] ? to : risk;
}

export function computeRisk(i: RiskInput): RiskAssessment {
  const reasons: string[] = [];
  let computed: Risk = "low";

  // 1. Path taxonomy floors. HIGH wins over MEDIUM via the floor() max.
  if (i.changedPaths.some(p => matchesAny(p, HIGH_FLOOR_GLOBS))) {
    computed = floor(computed, "high");
    reasons.push("touches sensitive paths (auth/security/payments/migrations/policies)");
  }
  if (i.changedPaths.some(p => matchesAny(p, MEDIUM_FLOOR_GLOBS))) {
    const next = floor(computed, "medium");
    if (next !== computed) reasons.push("touches build/deploy/dependency paths");
    computed = next;
  }

  // 2. Size bumps.
  const lines = i.additions + i.deletions;
  if (lines > 1500) {
    computed = floor(computed, "high");
    reasons.push(`very large change: ${lines} lines`);
  } else if (lines > 400) {
    computed = bump(computed);
    reasons.push(`large change: ${lines} lines`);
  }

  // 3. Mass deletion — a removal-heavy diff is risky even when small overall.
  if (i.deletions > 200 && i.deletions > 3 * i.additions) {
    const next = floor(computed, "medium");
    if (next !== computed) reasons.push(`mass deletion: ${i.deletions} lines removed`);
    computed = next;
  }

  // 4. Source changed without any test changes — capped at high so a missing
  // test never escalates to critical on its own.
  const touchesSource = i.changedPaths.some(isSource);
  const touchesTest = i.changedPaths.some(isTest);
  if (touchesSource && !touchesTest) {
    computed = bump(computed, "high");
    reasons.push("code changed without test changes");
  }

  // 5. Author track record — a history of rollbacks raises scrutiny.
  if (i.agentPriorRollbacks > 0) {
    computed = bump(computed, "high");
    reasons.push(`author agent has ${i.agentPriorRollbacks} rolled-back change${i.agentPriorRollbacks === 1 ? "" : "s"} in this repo`);
  }

  // 6. Declared risk is a floor too: agents can raise their own risk, never
  // lower the computed one. final = max(declared, computed).
  let final = computed;
  if (RANK[i.declared] > RANK[computed]) {
    final = i.declared;
    reasons.push(`agent-declared risk: ${i.declared}`);
  }

  return { risk: final, reasons };
}
