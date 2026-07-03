import { minimatch } from "minimatch";
import { HIGH_FLOOR_GLOBS, MEDIUM_FLOOR_GLOBS, isGeneratedFile } from "./risk-engine.js";
import { BASELINE_SENSITIVE_GLOBS } from "./merge-policy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic focus floor (M1 of the review overhaul).
//
// "inference informs, determinism decides" — before any LLM ever runs, every
// push already gets a ranked, explained focus set synthesized purely from the
// diff the server already computed. This kills the empty-focus state: a
// trailer-less push no longer force-renders every file with an apology banner.
//
// `synthesizeReviewBrief()` is PURE — no DB, no git, no clock. Post-push feeds
// it the numstat, the sensitive-path hunk headers, and any rollback episodes
// overlapping the changed paths; it returns the Review Brief stored on
// `changes.reviewBrief`. Purity keeps re-pushes idempotent (same diff → same
// brief) and makes the whole thing unit-testable with zero fixtures.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a focus item / callout came from. Frozen enum (ground rule 2). */
export type FocusSource = "sensitive" | "risk" | "rollback" | "cochange";

/** Line-anchored derived focus — the deterministic analogue of a Review-Focus
 *  trailer, but computed instead of authored. Shape is Review-Focus + reason +
 *  source so the diff surface renders it identically, source-tagged. */
export interface DerivedFocus {
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
  source: "sensitive" | "risk";
}

/** One changed file, ranked by churn × sensitivity. Generated files are kept
 *  (never hidden) but demoted to the bottom. */
export interface BriefFile {
  path: string;
  additions: number;
  deletions: number;
  sensitivity: "high" | "medium" | "none";
  generated: boolean;
}

/** A path-level heads-up that isn't a single line range — a prior rollback that
 *  overlaps these paths, or (stretch) a companion file that usually ships with
 *  them but didn't. */
export interface BriefCallout {
  source: "rollback" | "cochange";
  message: string;
  paths: string[];
}

/** The synthesized Review Brief. Stored verbatim on `changes.reviewBrief`. */
export interface ReviewBrief {
  derivedFocus: DerivedFocus[];
  files: BriefFile[];
  callouts: BriefCallout[];
}

export interface SynthesisInput {
  /** Per-file line counts from the one numstat post-push already ran. */
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** New-side hunk ranges for the sensitive-path subset only (git.diffHunks). */
  sensitiveHunks: Array<{ path: string; startLine: number; endLine: number }>;
  /** Prior rolled-back changes in this repo whose paths overlap this diff. */
  rollbackEpisodes?: Array<{ paths: string[]; intent: string; reason?: string | null }>;
  /** (Stretch) companion files that usually ship with the changed set but are
   *  absent here — an authored `absent`, plus the `present` sibling that names
   *  the pattern. Cut first under time pressure; empty = no cochange callouts. */
  cochangeGaps?: Array<{ absent: string; alongside: string }>;
}

/** Hard cap on derived flags — the #1 review complaint is noise, so the floor
 *  is precision-capped like the native reviewer will be. */
const MAX_FLAGS = 20;

function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(g => minimatch(path, g, { dot: true }));
}

/** high / medium / none, by the risk-engine taxonomy. HIGH wins. */
export function pathSensitivity(path: string): "high" | "medium" | "none" {
  if (matchesAny(path, HIGH_FLOOR_GLOBS)) return "high";
  if (matchesAny(path, MEDIUM_FLOOR_GLOBS)) return "medium";
  return "none";
}

const SENS_WEIGHT: Record<"high" | "medium" | "none", number> = { high: 4, medium: 2, none: 1 };

/** Ranking score within a partition: churn × sensitivity. Deterministic. */
function fileScore(f: BriefFile): number {
  return (f.additions + f.deletions) * SENS_WEIGHT[f.sensitivity];
}

/** Reason string for a sensitive-path flag — names WHY the path is sensitive so
 *  the reviewer sees the decision, not just a highlight. */
function sensitiveReason(path: string, sensitivity: "high" | "medium"): string {
  if (matchesAny(path, BASELINE_SENSITIVE_GLOBS)) {
    return "sensitive path (deploy/CI/policy/migration) — always human-reviewed";
  }
  if (sensitivity === "high") return "high-risk path (auth/security/payments/schema)";
  return "build/deploy/dependency path";
}

/** The pure synthesizer. Deterministic in its inputs; no I/O. */
export function synthesizeReviewBrief(input: SynthesisInput): ReviewBrief {
  // 1. Rank the files by churn × sensitivity, generated demoted to the bottom.
  const files: BriefFile[] = input.files.map(f => ({
    path: f.path,
    additions: f.additions,
    deletions: f.deletions,
    sensitivity: pathSensitivity(f.path),
    generated: isGeneratedFile(f.path),
  }));
  files.sort((a, b) => {
    // Generated files are a hard partition at the bottom — a 5,000-line
    // regenerated lockfile must never outrank hand-authored code, however small.
    if (a.generated !== b.generated) return a.generated ? 1 : -1;
    const d = fileScore(b) - fileScore(a);
    if (d !== 0) return d;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; // stable tiebreak → idempotent
  });

  // 2. Derived focus from sensitive-path hunks: HIGH first, then MEDIUM, capped.
  //    Deterministic order (path asc, then line asc) so re-pushes are idempotent.
  const flags: DerivedFocus[] = [];
  const ranked = [...input.sensitiveHunks]
    .map(h => ({ ...h, sens: pathSensitivity(h.path) }))
    .filter(h => h.sens !== "none")
    .sort((a, b) => {
      const w = SENS_WEIGHT[b.sens] - SENS_WEIGHT[a.sens];
      if (w !== 0) return w;
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.startLine - b.startLine;
    });
  for (const h of ranked) {
    if (flags.length >= MAX_FLAGS) break;
    flags.push({
      path: h.path,
      startLine: h.startLine,
      endLine: h.endLine,
      reason: sensitiveReason(h.path, h.sens as "high" | "medium"),
      source: "sensitive",
    });
  }

  // 3. Callouts. Rollback episodes whose paths overlap this diff — the strongest
  //    negative signal the platform has recorded about this area of the tree.
  const callouts: BriefCallout[] = [];
  const changedSet = new Set(input.files.map(f => f.path));
  const seenRollback = new Set<string>();
  for (const ep of input.rollbackEpisodes ?? []) {
    const overlap = (ep.paths ?? []).filter(p => changedSet.has(p));
    if (!overlap.length) continue;
    const key = overlap.slice().sort().join("|") + "::" + ep.intent;
    if (seenRollback.has(key)) continue;
    seenRollback.add(key);
    callouts.push({
      source: "rollback",
      message: `A prior change here was rolled back${ep.reason ? `: ${ep.reason}` : ""} (original intent: ${ep.intent}). Treat these files with extra care.`,
      paths: overlap.slice(0, 10),
    });
  }
  // 4. (Stretch) co-change gaps — a file that usually ships with this set is absent.
  for (const g of input.cochangeGaps ?? []) {
    if (!changedSet.has(g.alongside)) continue;
    callouts.push({
      source: "cochange",
      message: `${g.absent} usually changes together with ${g.alongside} but isn't in this diff — verify it doesn't also need updating.`,
      paths: [g.alongside],
    });
  }

  return { derivedFocus: flags, files, callouts };
}

/** True when a path is sensitive at all (high or medium) — the subset
 *  focus-synthesis asks git.diffHunks about. */
export function isSensitivePath(path: string): boolean {
  return pathSensitivity(path) !== "none";
}
