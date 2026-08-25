import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, changes, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { Risk } from "./trailer-parser.js";
import { describeCommits } from "./trailer-parser.js";
import { computeRisk, isGeneratedFile } from "./risk-engine.js";
import { synthesizeReviewBrief, isSensitivePath, type ReviewBrief } from "./focus-synthesis.js";
import { selectVerifyTier, parseVerifyYmlInfo, type VerifyTierPolicy } from "./verify-tier.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// The ONE implementation of a Change's server-side metadata derivation —
// authoritative changed paths, computed risk, Review Brief, verify tier,
// description — shared by post-push (every push) and the cross-repo-proposal
// accept path (#127), which imports commits authored in a repository the
// target's maintainers do not control and therefore must re-derive against the
// TARGET rather than trust the source row. A second copy would drift from the
// first, which is the failure mode public-stats.ts (#122) was created to end.

export interface DiffStats {
  paths: string[];
  additions: number;
  deletions: number;
  files: Array<{ path: string; additions: number; deletions: number }>;
}

/**
 * #196: the authoritative diff base is the MERGE BASE of (base, head), not the
 * base tip. A two-dot diff against the tip attributes every file the base
 * branch changed since the fork point to the Change — inflating risk, tripping
 * the sensitive-path gate on files not in the on-screen diff (which
 * routes/changes.ts already renders merge-base-relative), and in the converse
 * direction dropping a genuinely-touched path the base independently converged
 * on. Falls back to the base ref when no merge base exists (unrelated
 * histories / first push), where `..` and `...` coincide anyway.
 */
export async function resolveDiffBase(git: GitService, namespace: string, repoName: string, base: string, head: string): Promise<string> {
  return (await git.mergeBase(namespace, repoName, base, head)) ?? base;
}

/**
 * Computed risk from the diff — declared risk stays a floor, prior rolled-back
 * Changes by the same author in this repo bump it, and generated/derived files
 * are excluded from the size metric. Best-effort: a failure keeps the declared
 * risk with no reasons (logged `risk_compute_failed`).
 */
export async function deriveComputedRisk(db: DB, opts: {
  repoId: string;
  declared: Risk;
  changedPaths: string[];
  stat: DiffStats | null;
  authorAgentId: string | null;
  authorUserId: string | null;
}): Promise<{ risk: Risk; reasons: string[] }> {
  const { repoId, declared, changedPaths, stat, authorAgentId, authorUserId } = opts;
  try {
    if (!stat) throw new Error("numstat_unavailable"); // logged as risk_compute_failed; numstat_failed already fired
    // Track-record floor: prior rolled-back Changes by THIS author in THIS
    // repo bump risk. Counted per author identity — agent or human.
    let priorRollbacks = 0;
    if (authorAgentId || authorUserId) {
      priorRollbacks = (await db.select({ id: changes.id }).from(changes).where(and(
        eq(changes.repoId, repoId),
        authorAgentId ? eq(changes.openedByAgentId, authorAgentId) : eq(changes.openedByUserId, authorUserId!),
        eq(changes.status, "rolled_back"),
      ))).length;
    }
    // Size metric excludes generated/derived files (lockfiles, snapshots, build
    // output). A 1,983-line package-lock.json must not push a normal first
    // commit to "very large change" → HIGH and block the solo workflow. The
    // full changedPaths above are still used for the path-floor logic.
    let sizeAdds = stat.additions, sizeDels = stat.deletions;
    for (const f of stat.files) {
      if (isGeneratedFile(f.path)) { sizeAdds -= f.additions; sizeDels -= f.deletions; }
    }
    return computeRisk({
      declared,
      changedPaths,
      additions: Math.max(0, sizeAdds),
      deletions: Math.max(0, sizeDels),
      agentPriorRollbacks: priorRollbacks,
    });
  } catch (e) {
    log("warn", "risk_compute_failed", { repoId, err: (e as Error).message });
    return { risk: declared, reasons: [] };
  }
}

/**
 * Deterministic focus floor (M1): synthesize a Review Brief from the diff so a
 * trailer-less push never renders the empty-focus state. Best-effort — a
 * failure returns null and the UI falls back to today's layout. Kill switch:
 * CLAWHUB_DISABLE_FOCUS_SYNTHESIS=1. Only the small sensitive subset of paths
 * gets a second git process (diffHunks); everything else is pure ranking over
 * the numstat the caller already has.
 */
export async function deriveReviewBrief(db: DB, git: GitService, opts: {
  namespace: string;
  repoName: string;
  repoId: string;
  diffBase: string;
  head: string;
  changedPaths: string[];
  statFiles: Array<{ path: string; additions: number; deletions: number }>;
}): Promise<ReviewBrief | null> {
  const { namespace, repoName, repoId, diffBase, head, changedPaths, statFiles } = opts;
  if (process.env.CLAWHUB_DISABLE_FOCUS_SYNTHESIS === "1") return null;
  // HARD DEADLINE (D3, 400ms): synthesis runs on the serial post-push worker,
  // and its only slow leg — git.diffHunks, a subprocess on the (possibly
  // contended/sharded) git tier — would otherwise head-of-line-block EVERY
  // queued push behind one slow diff. Past the deadline we leave the brief null
  // (the UI falls back to today's layout) and move on. The kill switch above is
  // global; this is the per-push safety valve the plan decided on.
  const DEADLINE_MS = Number(process.env.CLAWHUB_FOCUS_SYNTHESIS_DEADLINE_MS ?? 400);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reviewBrief: ReviewBrief | null = null;
  try {
    reviewBrief = await Promise.race<ReviewBrief>([
      (async (): Promise<ReviewBrief> => {
        const sensitivePaths = changedPaths.filter(isSensitivePath).slice(0, 40);
        const sensitiveHunks = sensitivePaths.length
          ? await git.diffHunks(namespace, repoName, diffBase, head, sensitivePaths)
          : [];
        // Rollback episodes overlapping the changed paths — the platform's own
        // recorded "this area burned us before" signal (memory-capture rows).
        let rollbackEpisodes: Array<{ paths: string[]; intent: string; reason?: string | null }> = [];
        try {
          const rows = await db.select({ body: agentMemories.body, facts: agentMemories.facts, title: agentMemories.title })
            .from(agentMemories)
            .where(and(
              eq(agentMemories.scopeKey, `repo:${repoId}`),
              eq(agentMemories.kind, "failure"),
              isNull(agentMemories.validTo),
            )).limit(50);
          const changedSet = new Set(changedPaths);
          rollbackEpisodes = rows
            .map(row => {
              const facts = (row.facts ?? {}) as { paths?: unknown };
              const paths = Array.isArray(facts.paths) ? facts.paths.filter((p): p is string => typeof p === "string") : [];
              return { paths, intent: (row.title ?? "").replace(/^Rolled back:\s*/, ""), reason: null };
            })
            .filter(ep => ep.paths.some(p => changedSet.has(p)));
        } catch (e) { log("warn", "focus_rollback_lookup_failed", { repoId, err: (e as Error).message }); }
        return synthesizeReviewBrief({
          files: statFiles.length ? statFiles : changedPaths.map(p => ({ path: p, additions: 0, deletions: 0 })),
          sensitiveHunks,
          rollbackEpisodes,
        });
      })(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("focus_synthesis_deadline")), DEADLINE_MS); }),
    ]);
    metrics.inc("clawhub_focus_synthesis_total", { result: reviewBrief.derivedFocus.length ? "flagged" : "empty" });
  } catch (e) {
    if ((e as Error).message === "focus_synthesis_deadline") metrics.inc("clawhub_focus_synthesis_total", { result: "timeout" });
    else log("warn", "focus_synthesis_failed", { repoId, err: (e as Error).message });
  } finally { if (timer) clearTimeout(timer); }
  return reviewBrief;
}

/**
 * e2e verification TIER — server-derived (services/verify-tier.ts), the single
 * source of truth that demotes the heavy DinD boot to opt-in. The FLOOR comes
 * from the diff paths + repo policy + effective risk (a Change can't downgrade
 * itself below it, must-fix #2); the shape from the head .clawhub/verify.yml.
 * Best-effort: a failure leaves it null and the dispatch falls back safely.
 */
export async function deriveVerifyTier(db: DB, git: GitService, opts: {
  namespace: string;
  repoName: string;
  repoId: string;
  head: string;
  changedPaths: string[];
  effectiveRisk: Risk;
}): Promise<{ verifyTier: string | null; verifyTierReason: string | null }> {
  const { namespace, repoName, repoId, head, changedPaths, effectiveRisk } = opts;
  try {
    const verifyRaw = (await git.filesAt(namespace, repoName, head, [".clawhub/verify.yml"])).get(".clawhub/verify.yml") ?? null;
    const mp = ((await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0]?.mergePolicy ?? {}) as { verifyTier?: VerifyTierPolicy };
    const decision = selectVerifyTier({
      changedPaths,
      verifyYml: parseVerifyYmlInfo(verifyRaw),
      policy: mp.verifyTier ?? {},
      effectiveRisk,
    });
    return { verifyTier: decision.tier, verifyTierReason: decision.reason };
  } catch (e) {
    log("warn", "verify_tier_failed", { repoId, err: (e as Error).message });
    return { verifyTier: null, verifyTierReason: null };
  }
}

export interface DerivedChangeMetadata {
  changedPaths: string[] | null; // null = numstat failed (caller keeps its fallback)
  additions: number;
  deletions: number;
  computedRisk: Risk;
  riskReasons: string[];
  reviewBrief: ReviewBrief | null;
  verifyTier: string | null;
  verifyTierReason: string | null;
  description: string | null;
}

/**
 * Composite derivation for a head that arrived WITHOUT a push — today the
 * cross-repo-proposal accept (#127). Runs every leg against
 * mergeBase(base, head)..head in the repo identified by (namespace, repoName,
 * repoId); each leg is best-effort in the same shape post-push uses (a failing
 * leg leaves its field null/empty and logs — it must not abort the accept).
 */
export async function deriveChangeMetadata(db: DB, git: GitService, opts: {
  namespace: string;
  repoName: string;
  repoId: string;
  base: string;   // the branch the Change will merge into (the repo default)
  head: string;
  declaredRisk: Risk;
  authorAgentId: string | null;
  authorUserId: string | null;
}): Promise<DerivedChangeMetadata> {
  const { namespace, repoName, repoId, base, head, declaredRisk, authorAgentId, authorUserId } = opts;
  const diffBase = await resolveDiffBase(git, namespace, repoName, base, head);

  let stat: DiffStats | null = null;
  try {
    stat = await git.numstat(namespace, repoName, diffBase, head);
  } catch (e) { log("warn", "numstat_failed", { repoId, err: (e as Error).message }); }
  const changedPaths = stat ? stat.paths : null;

  const riskAssessment = await deriveComputedRisk(db, {
    repoId, declared: declaredRisk, changedPaths: changedPaths ?? [], stat, authorAgentId, authorUserId,
  });

  const reviewBrief = await deriveReviewBrief(db, git, {
    namespace, repoName, repoId, diffBase, head,
    changedPaths: changedPaths ?? [], statFiles: stat?.files ?? [],
  });

  const tier = await deriveVerifyTier(db, git, {
    namespace, repoName, repoId, head,
    changedPaths: changedPaths ?? [], effectiveRisk: riskAssessment.risk,
  });

  let description: string | null = null;
  try {
    const commits = await git.listCommits(namespace, repoName, `${diffBase}..${head}`, 200);
    description = describeCommits(commits);
  } catch (e) { log("warn", "describe_commits_failed", { repoId, err: (e as Error).message }); }

  return {
    changedPaths,
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    computedRisk: riskAssessment.risk,
    riskReasons: riskAssessment.reasons,
    reviewBrief,
    verifyTier: tier.verifyTier,
    verifyTierReason: tier.verifyTierReason,
    description,
  };
}
