import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import type { Risk } from "./trailer-parser.js";

/**
 * Tier selection for e2e verification — the deterministic, SERVER-derived sibling
 * of risk-engine.ts (no LLM). Picks the CHEAPEST tier that can honestly prove a
 * Change's diff, so the heavy `--privileged` Docker-in-Docker boot becomes the
 * opt-in last resort instead of the per-Change default.
 *
 *   static   — typecheck/lint/affected tests, NO app boot (non-privileged, seconds)
 *   app      — one dev-server (next dev/vite) vs warm deps + mock/shared backend,
 *              browser-tested (non-privileged, seconds) — cheapest REAL UI verify
 *   services — the changed process(es) vs POOLED Postgres/Redis + a fresh per-run DB,
 *              no build, no DinD (non-privileged + runner-private bridge, low minutes)
 *   dind     — full `docker compose up` in a privileged nested daemon (heavy, GBs) —
 *              the correctness backstop, only when the diff truly needs its own Docker
 *
 * SECURITY (the must-fix the adversarial review flagged): the FLOOR is computed only
 * from server-side, change-independent signals — sensitive baseline paths, the DB
 * merge policy, and the server `nonBehavioralGlobs` constant. A Change's own
 * `.clawhub/verify.yml` may only request a tier AT OR ABOVE the floor and may NARROW
 * what it claims — it can NEVER relabel its code non-behavioral or drop below the
 * floor to dodge real verification. Isolation strength scales WITH the tier, so the
 * cheap tiers are also the safe ones.
 */

export type VerifyTier = "static" | "app" | "services" | "dind";
export const VERIFY_TIERS: VerifyTier[] = ["static", "app", "services", "dind"];
export const VERIFY_TIER_ORDER: Record<VerifyTier, number> = { static: 0, app: 1, services: 2, dind: 3 };

export function isVerifyTier(v: unknown): v is VerifyTier {
  return typeof v === "string" && (VERIFY_TIERS as string[]).includes(v);
}
function maxTier(a: VerifyTier, b: VerifyTier): VerifyTier {
  return VERIFY_TIER_ORDER[a] >= VERIFY_TIER_ORDER[b] ? a : b;
}

// SERVER-CONTROLLED (must-fix #2): an author CANNOT relabel their own code as
// "non-behavioral" to land in a cheaper tier — this list is a constant, never read
// from the change's verify.yml. Only diffs touching EXCLUSIVELY these paths may
// infer `static` (no boot). Lockfiles count as non-behavioral for the SIZE/boot
// decision but still bump the dep-cache key, so a dep change re-installs.
const NON_BEHAVIORAL_GLOBS = [
  "**/*.md", "docs/**", "**/*.txt", "LICENSE", "LICENSE.*", "**/CODEOWNERS",
  "**/*.test.ts", "**/*.test.tsx", "**/*.test.js", "**/*.spec.ts", "**/*.spec.tsx",
  "**/__tests__/**", "**/__snapshots__/**", "**/*.snap",
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/go.sum", "**/*.lock",
];
// Topology paths: the diff changes how the stack is BUILT/wired, so it can only be
// proven by rebuilding that stack in a fresh daemon → `dind` floor.
const TOPOLOGY_GLOBS = [
  "docker-compose*.yml", "docker-compose*.yaml", "**/docker-compose*.yml",
  "**/Dockerfile", "Dockerfile*", "**/Dockerfile.*", "deploy/**", ".clawhub/ci/**",
];
// DB/schema paths: must run against a REAL database → `services` floor (at least).
const DB_GLOBS = ["**/migrations/**", "**/*.sql"];

function anyMatch(paths: string[], globs: string[]): boolean {
  return paths.some(p => globs.some(g => minimatch(p, g, { dot: true })));
}
function everyMatch(paths: string[], globs: string[]): boolean {
  return paths.length > 0 && paths.every(p => globs.some(g => minimatch(p, g, { dot: true })));
}

/** What the resolver needs to know from a repo's `.clawhub/verify.yml` (server-parsed). */
export interface VerifyYmlInfo {
  tier: VerifyTier | "auto" | null; // explicit `tier:` (a request, subject to the floor)
  hasServe: boolean;                // a `serve` command is declared
  serveUsesDocker: boolean;         // that command runs docker/compose → needs a daemon
  hasServices: boolean;             // a `services:` block (pooled DB/Redis) is declared
  hasUrl: boolean;                  // a `url` to hit is declared
}

const EMPTY_INFO: VerifyYmlInfo = { tier: null, hasServe: false, serveUsesDocker: false, hasServices: false, hasUrl: false };

/**
 * Minimal, defensive parse of `.clawhub/verify.yml` for the signals the tier
 * resolver needs. Tolerant: any parse failure yields EMPTY_INFO (→ resolver falls
 * back to diff-shape inference), never throws.
 */
export function parseVerifyYmlInfo(raw: string | null | undefined): VerifyYmlInfo {
  if (!raw || !raw.trim()) return EMPTY_INFO;
  let doc: Record<string, unknown> | null = null;
  try { doc = parseYaml(raw) as Record<string, unknown>; } catch { doc = null; }
  if (!doc || typeof doc !== "object") return EMPTY_INFO;
  const serve = typeof doc.serve === "string" ? doc.serve : "";
  const tierRaw = typeof doc.tier === "string" ? doc.tier.trim() : "";
  const services = doc.services;
  return {
    tier: tierRaw === "auto" ? "auto" : isVerifyTier(tierRaw) ? tierRaw : null,
    hasServe: serve.trim().length > 0 || typeof doc.serve === "object",
    serveUsesDocker: /\bdocker(\s|-)/.test(serve) || /\bcompose\b/.test(serve),
    hasServices: !!services && typeof services === "object" && Object.keys(services as object).length > 0,
    hasUrl: typeof doc.url === "string" && (doc.url as string).trim().length > 0,
  };
}

export interface VerifyTierPolicy {
  // The repo's DB merge policy can FORCE a minimum verification depth — server
  // config, NOT the change's verify.yml. Floor only, can only push UP.
  minVerifyTier?: VerifyTier;
  // Per-glob forced tiers from the DB policy (e.g. a repo pins `infra/**` → dind).
  forceTierGlobs?: Array<{ glob: string; tier: VerifyTier }>;
  // When false, the privileged dind surface is forbidden on this repo: a diff that
  // would need dind is capped at `services` (and so cannot auto-merge via verified
  // autonomy — it falls to a human). Default true.
  allowDind?: boolean;
}

export interface VerifyTierInputs {
  changedPaths: string[];
  verifyYml: VerifyYmlInfo | null;
  policy?: VerifyTierPolicy;
  // Effective risk (max declared/computed). Higher risk raises the floor so a
  // risky change can't be "verified" by a no-boot static run.
  effectiveRisk?: Risk;
}

export interface VerifyTierDecision {
  tier: VerifyTier;
  floor: VerifyTier;            // the server-derived minimum (can only force up)
  requested: VerifyTier | null; // what the change's verify.yml asked for (if any)
  inferred: VerifyTier;         // what the diff shape implies
  reason: string;
}

const RISK_FLOOR: Record<Risk, VerifyTier> = {
  // A high/critical change must at least boot the app+services to be auto-mergeable
  // via a verified attestation; low/medium may be proven by a cheaper tier.
  low: "static", medium: "static", high: "services", critical: "services",
};

/**
 * Pick the verification tier for a Change. Pure + deterministic. Precedence:
 *   (1) SERVER floor — sensitive/topology/db paths, forceTierGlobs, minVerifyTier,
 *       risk — can only force the tier UP;
 *   (2) the change's explicit `tier:` request (clamped to >= floor);
 *   (3) inference from the diff shape + serve recipe;
 *   (4) default — `app` if a serve+url exist, else `static`.
 * `allowDind:false` caps the result at `services`.
 */
export function selectVerifyTier(inputs: VerifyTierInputs): VerifyTierDecision {
  const paths = inputs.changedPaths ?? [];
  const info = inputs.verifyYml ?? EMPTY_INFO;
  const policy = inputs.policy ?? {};
  const reasons: string[] = [];

  // (1) SERVER floor.
  let floor: VerifyTier = "static";
  for (const f of policy.forceTierGlobs ?? []) {
    if (isVerifyTier(f.tier) && anyMatch(paths, [f.glob])) { floor = maxTier(floor, f.tier); reasons.push(`policy forces ${f.tier} for ${f.glob}`); }
  }
  if (anyMatch(paths, TOPOLOGY_GLOBS)) { floor = maxTier(floor, "dind"); reasons.push("diff changes stack topology (compose/Dockerfile/deploy/ci)"); }
  if (anyMatch(paths, DB_GLOBS)) { floor = maxTier(floor, "services"); reasons.push("diff touches db schema/migrations"); }
  if (policy.minVerifyTier) { floor = maxTier(floor, policy.minVerifyTier); reasons.push(`policy minVerifyTier=${policy.minVerifyTier}`); }
  if (inputs.effectiveRisk) {
    const rf = RISK_FLOOR[inputs.effectiveRisk];
    if (VERIFY_TIER_ORDER[rf] > VERIFY_TIER_ORDER[floor]) { floor = rf; reasons.push(`risk=${inputs.effectiveRisk} floors at ${rf}`); }
  }

  // (2) explicit request (a real tier, not "auto").
  const requested: VerifyTier | null = isVerifyTier(info.tier) ? info.tier : null;

  // (3) inference from diff shape + serve recipe.
  let inferred: VerifyTier;
  if (everyMatch(paths, NON_BEHAVIORAL_GLOBS)) { inferred = "static"; reasons.push("diff is non-behavioral (docs/tests/lockfiles)"); }
  else if (info.serveUsesDocker) { inferred = "dind"; reasons.push("serve uses docker/compose"); }
  else if (info.hasServices) { inferred = "services"; reasons.push("verify.yml declares services"); }
  else if (info.hasServe) { inferred = "app"; reasons.push("verify.yml declares a single-process serve"); }
  else { inferred = "static"; reasons.push("no serve declared"); }

  // (4) choose: floor wins, then the request (if >= floor), else inference.
  let tier = maxTier(floor, requested ?? inferred);
  if (requested && VERIFY_TIER_ORDER[requested] < VERIFY_TIER_ORDER[floor]) reasons.push(`requested ${requested} clamped up to floor ${floor}`);

  // (5) dind disabled → cap at services (the change then needs a human, by gate).
  if (tier === "dind" && policy.allowDind === false) { tier = "services"; reasons.push("dind disabled by policy → capped at services (human-gated)"); }

  return { tier, floor, requested, inferred, reason: reasons.join("; ") || "default" };
}
