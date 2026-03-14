import { eq, sql } from "drizzle-orm";
import { reviews } from "../models/schema.js";
import type { Database } from "../models/db.js";

/**
 * Count review verdicts for a given change.
 */
export async function countReviewVerdicts(
  db: Database,
  changeId: string
): Promise<{ approvals: number; requestChanges: number; comments: number }> {
  const rows = await db
    .select({
      verdict: reviews.verdict,
      count: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(eq(reviews.changeId, changeId))
    .groupBy(reviews.verdict);

  let approvals = 0;
  let requestChanges = 0;
  let comments = 0;

  for (const row of rows) {
    switch (row.verdict) {
      case "approve":
        approvals = row.count;
        break;
      case "request_changes":
        requestChanges = row.count;
        break;
      case "comment":
        comments = row.count;
        break;
    }
  }

  return { approvals, requestChanges, comments };
}
