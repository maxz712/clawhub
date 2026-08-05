import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { reviews } from "../models/schema.js";
import { metrics } from "./metrics.js";

/**
 * #121 — dismiss the approvals of the diff a Change just stopped being.
 *
 * A `reviews` row is pinned to the exact commit it was submitted against
 * (`reviews.head_commit`, stamped in routes/reviews.ts). When a push moves a
 * Change's head, every approval naming a different commit is an approval of code
 * that is no longer what would merge — so it is superseded, in the SAME
 * transaction that writes the new head, leaving no window in which the merge gate
 * can see the new commit beside the old approval.
 *
 * This closes the last head-pinned trust signal that leaked across diffs. The
 * auto-merge arm, the verified-autonomy attestation, the advisory review, the
 * verify plan and CI were all already invalidated on a new push; a human
 * `approve` was not, so approving a benign diff and then pushing a sensitive one
 * satisfied `codeReviewRequiredAtRisk` / `sensitiveBaseline` with code nobody read.
 *
 * Deliberately narrow about WHAT it dismisses:
 *   • `approve` only. `request_changes` is the NEGATIVE signal — dismissing it
 *     would WEAKEN the gate, so it survives a push (ChangeService.reopen stays the
 *     one intentional dismissal of it). `comment` is additive and untouched.
 *   • non-advisory only — the native reviewer's advisory rows have their own
 *     supersede path and never satisfy an approval slot anyway.
 *   • a NULL pin (a row predating the column) counts as MISMATCHED, so a legacy
 *     approval is dismissed on the first push rather than grandfathered into
 *     "matches every commit". Same fail-closed posture as `computedRisk ?? "high"`.
 *
 * @param tx      the transaction holding the per-(repo, branch) advisory lock
 * @param newHead the commit the Change is moving TO
 * @returns how many approvals were dismissed
 */
export async function dismissStaleApprovals(tx: DB, changeId: string, newHead: string): Promise<number> {
  const dismissed = await tx.update(reviews).set({ supersededAt: new Date() }).where(and(
    eq(reviews.changeId, changeId),
    eq(reviews.verdict, "approve"),
    eq(reviews.advisory, false),
    isNull(reviews.supersededAt),
    or(isNull(reviews.headCommit), ne(reviews.headCommit, newHead)),
  )).returning({ id: reviews.id });
  if (dismissed.length) metrics.inc("clawhub_stale_approvals_dismissed_total", {}, dismissed.length);
  return dismissed.length;
}
