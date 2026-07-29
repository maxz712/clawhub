import { and, eq, lt } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues } from "../models/schema.js";
import { log } from "./logger.js";

// #42: daily sweep — closed issues untouched for CLAWHUB_ISSUE_ARCHIVE_DAYS
// (default 30) transition to "archived". Nothing is deleted; archived issues
// remain queryable via ?status=archived. Timers are unref'd so tests/CLI exits
// are never held open, mirroring the memory-decay sweep.
export async function archiveStaleClosedIssues(db: DB): Promise<number> {
  const days = Number(process.env.CLAWHUB_ISSUE_ARCHIVE_DAYS) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 3600_000);
  const rows = await db.update(issues).set({ status: "archived", updatedAt: new Date() })
    .where(and(eq(issues.status, "closed"), lt(issues.updatedAt, cutoff))).returning({ id: issues.id });
  if (rows.length) log("info", "issues_auto_archived", { count: rows.length });
  return rows.length;
}

export function startIssueArchiveSweep(db: DB): void {
  const boot = setTimeout(() => { void archiveStaleClosedIssues(db).catch(e => log("warn", "issue_archive_sweep_failed", { err: (e as Error).message })); }, 60_000);
  if (typeof boot.unref === "function") boot.unref();
  const timer = setInterval(() => { void archiveStaleClosedIssues(db).catch(e => log("warn", "issue_archive_sweep_failed", { err: (e as Error).message })); }, 24 * 3600_000);
  if (typeof timer.unref === "function") timer.unref();
}
