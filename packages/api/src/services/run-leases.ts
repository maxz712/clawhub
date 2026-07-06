import { and, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns } from "../models/schema.js";
import { log } from "./logger.js";

/**
 * v3 P4 — coalesce-to-latest run leases (docs/redesign-v3.md §4).
 *
 * Dedup for agent-origin runs is keyed `agent:<id>:<mode>:<resource>@version`
 * (version = the commit for change-pinned runs). Policy is COALESCE TO
 * LATEST, never FIFO: an identical pending request is dropped; a pending run
 * about a STALE head collapses to `skipped` when a newer one arrives; nothing
 * ever waits in line behind obsolete work.
 *
 * Deliberately built ON the existing machinery rather than beside it:
 *   - `ci_runs_running_group_uniq` already enforces ≤1 RUNNING per group;
 *   - `dispatchNextInGroup` (ci-runner.ts) already promotes the NEWEST
 *     pending run on terminal and collapses older ones;
 *   - `ci_runs_standing_pending_uniq` already caps pending per agent.
 * This module adds the group KEY for agent runs + same-version dedup.
 */

/** The lease group for an agent-origin run. resource = changeId | "repo". */
export function agentRunGroup(sa: { id: string; mode: string | null }, changeId?: string | null): string {
  return `agent:${sa.id}:${sa.mode ?? "worker"}:${changeId ?? "repo"}`;
}

const LIVE = ["pending", "running"] as const;

/**
 * Same-version dedup: is there already a live run in this group for this
 * exact commit? If so the new request is an exact duplicate — drop it.
 */
export async function hasLiveRunForVersion(db: DB, group: string, commit: string): Promise<boolean> {
  const rows = await db.select({ id: ciRuns.id }).from(ciRuns).where(and(
    eq(ciRuns.concurrencyGroup, group),
    eq(ciRuns.commit, commit),
    inArray(ciRuns.status, [...LIVE]),
  )).limit(1);
  return rows.length > 0;
}

/**
 * Coalesce: collapse PENDING runs in this group for a DIFFERENT (older)
 * commit to `skipped` — the newer request supersedes them. Running runs are
 * left to finish (their supersede is handled by cancelSupersededHeadRuns on
 * push and by newest-wins promotion at terminal).
 */
export async function collapseStalePending(db: DB, group: string, commit: string): Promise<number> {
  const rows = await db.update(ciRuns)
    .set({ status: "skipped", terminalReason: "superseded", finishedAt: new Date() })
    .where(and(
      eq(ciRuns.concurrencyGroup, group),
      eq(ciRuns.status, "pending"),
      ne(ciRuns.commit, commit),
    ))
    .returning({ id: ciRuns.id });
  if (rows.length) log("info", "run_lease_collapsed_stale", { group, commit, collapsed: rows.length });
  return rows.length;
}
