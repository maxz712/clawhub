import { eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues } from "../models/schema.js";
import { withChangeUpsertLock } from "./repo-lock.js";
import { ConflictError } from "./errors.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

/**
 * Race-safe per-repo issue NUMBER allocation (#119).
 *
 * Every creation site used to do `SELECT MAX(number)` then `INSERT max+1` as two
 * unguarded statements. `issues_repo_num_uniq` is the integrity backstop, so two
 * concurrent creates on the same repo made the loser die on a raw 23505 — a
 * plain 500 on the API path, and a SILENTLY DROPPED issue on the fire-and-forget
 * paths (Jira/Linear webhook sync, dep-scan). This module is the ONE code path
 * every site now goes through.
 *
 * Two layers, in the shape the repo already uses elsewhere:
 *  1. A per-repo Postgres ADVISORY lock (`withChangeUpsertLock`, the same
 *     primitive the Change upsert uses) serializes read-max + insert, so the
 *     common case never conflicts at all. The lock is transaction-scoped: it
 *     releases at COMMIT, which is exactly when our row becomes visible, so the
 *     next waiter reads a max that already includes it.
 *  2. A bounded RETRY on 23505 (the `verify-plan.ts` #81 remediation shape) is
 *     the backstop for the un-serialized fast path below and for any writer that
 *     bypasses the lock.
 *
 * Batch importers pass `numberHint` to keep their single-`MAX`-per-import
 * optimization: attempt 0 inserts the hint with no extra round-trip, and a
 * collision simply falls through to the locked recompute. Callers must advance
 * their counter from the RETURNED row's `number`, never from their own hint.
 */

// The advisory key is hash(repoId | scope) and the Change upsert keys the same
// space by BRANCH name. A colon can never appear in a git refname, so this
// scope provably cannot collide with a branch lock.
const LOCK_SCOPE = "::issue-number";
const MAX_ATTEMPTS = 8;

export type NewIssue = Omit<typeof issues.$inferInsert, "number">;
export type IssueRow = typeof issues.$inferSelect;

/** Postgres unique-violation, however the driver wrapped it. */
export function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: unknown }).code;
  if (code === "23505") return true;
  const cause = (e as { cause?: unknown }).cause;
  return !!cause && typeof cause === "object" && (cause as { code?: unknown }).code === "23505";
}

/**
 * Insert an issue, allocating its per-repo `number` atomically.
 *
 * @throws ConflictError only after MAX_ATTEMPTS contended attempts — a real
 * terminal failure is logged + metriced so it can never be a silent drop.
 */
export async function insertIssueWithNumber(
  db: DB,
  values: NewIssue,
  opts: { numberHint?: number } = {},
): Promise<IssueRow> {
  const repoId = values.repoId;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      // Fast path (importers only): try the caller's hint without a round-trip.
      if (attempt === 0 && opts.numberHint !== undefined) {
        const [row] = await db.insert(issues).values({ ...values, number: opts.numberHint }).returning();
        return row;
      }
      return await withChangeUpsertLock(db, repoId, LOCK_SCOPE, async tx => {
        const maxRow = await tx.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repoId));
        const number = (maxRow[0]?.m ?? 0) + 1;
        const [row] = await tx.insert(issues).values({ ...values, number }).returning();
        return row;
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      metrics.inc("clawhub_issue_number_conflict_total", { outcome: "retry" });
      // Jittered backoff so a burst of contenders doesn't re-collide in lockstep.
      await new Promise(res => setTimeout(res, 5 + Math.floor(Math.random() * 20)));
    }
  }
  metrics.inc("clawhub_issue_number_conflict_total", { outcome: "exhausted" });
  log("error", "issue_number_allocation_exhausted", { repoId, attempts: MAX_ATTEMPTS });
  throw new ConflictError("could not allocate an issue number — too much concurrent issue creation on this repo");
}
