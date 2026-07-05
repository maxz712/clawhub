// Staleness / stuck / supersede handling for the unified job abstraction.
// See docs/job-scheduler-design.md §5,§8. Two problems this closes:
//
//  1. STALE DIFF — a verify/review/CI run pinned to an old head keeps running (or
//     sits pending) after a newer push, an approval, or a merge/abandon made it
//     obsolete. Left alone it wastes a runner slot AND, worse, can attest/gate on a
//     diff that no longer exists. We CANCEL in-flight runs the moment they go stale.
//
//  2. STUCK PROCESS — a hung run makes no progress but hasn't hit its wall-clock
//     timeout. The runner heartbeats while alive; a running run whose heartbeat has
//     gone stale is treated as STUCK by the reaper (in ci-runner.ts) even before the
//     timeout, then retried (bounded) or failed.
//
// Cancellation marks the run `skipped` (it's obsolete, not broken — so it doesn't
// vote as a CI failure) with a terminalReason, publishes `ci.run.canceled` so the
// runner can kill a live container, and resets a standing agent that was mid-run
// back to idle so it can take fresh work immediately.

import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, standingAgents } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { recomputeChangeCiStatus } from "./ci-runner.js";
import type { TerminalReason } from "./job-scheduling.js";
import { log } from "./logger.js";
import { metrics } from "./metrics.js";

type CancelRow = {
  id: string;
  repoId: string;
  changeId: string | null;
  standingAgentId: string | null;
  status: string;
};

/**
 * Cancel a set of in-flight (pending|running) runs as stale/obsolete. Idempotent:
 * the status CAS (only fires while non-terminal) means a concurrent terminal report
 * or a second cancel is a no-op. Best-effort side effects; never throws out.
 */
async function cancelRuns(db: DB, events: EventBus, victims: CancelRow[], reason: TerminalReason): Promise<number> {
  if (!victims.length) return 0;
  const now = new Date();
  let n = 0;
  for (const v of victims) {
    // Single-shot CAS: skip the run only while it is still non-terminal, so we never
    // clobber a genuine terminal result that raced in.
    const done = await db.update(ciRuns).set({
      status: "skipped",
      finishedAt: now,
      terminalReason: reason,
      stepResults: [{ name: "canceled", note: `run canceled as ${reason} (superseded by a newer head or a terminal change state)` }],
    }).where(and(eq(ciRuns.id, v.id), inArray(ciRuns.status, ["pending", "running"]))).returning({ id: ciRuns.id });
    if (!done.length) continue;
    n++;

    // Tell the runner to kill a live container (best-effort; the runner's wall-clock
    // SIGKILL is the backstop if the event is missed).
    if (v.status === "running") {
      await events.publish({ type: "ci.run.canceled", repoId: v.repoId, changeId: v.changeId ?? undefined, payload: { runId: v.id, reason } });
    }
    // A standing agent that was mid-run on this now-obsolete run is freed to idle so
    // it can immediately pick up the fresh work — WITHOUT counting a failure (a
    // supersede is not the agent's fault, so it must not feed the circuit breaker).
    if (v.standingAgentId) {
      await db.update(standingAgents).set({ status: "idle", lastError: null })
        .where(and(eq(standingAgents.id, v.standingAgentId), eq(standingAgents.lastRunId, v.id)));
    }
    if (v.changeId) await recomputeChangeCiStatus(db, v.changeId);
  }
  if (n) metrics.inc("clawhub_run_canceled_total", { reason });
  return n;
}

/**
 * A new push moved a change's head to `newHead`: cancel every in-flight run for the
 * change that is pinned to a DIFFERENT commit (the stale diff). The freshly-queued
 * runs for `newHead` are untouched. Call from post-push after the Change upsert.
 */
export async function cancelSupersededHeadRuns(db: DB, events: EventBus, changeId: string, newHead: string): Promise<number> {
  const victims = await db.select({ id: ciRuns.id, repoId: ciRuns.repoId, changeId: ciRuns.changeId, standingAgentId: ciRuns.standingAgentId, status: ciRuns.status, commit: ciRuns.commit })
    .from(ciRuns)
    // NEVER the merge→deploy run (origin='merge'): a push can reuse a MERGED change's
    // (repoId,branch) row (post-push upserts by branch, no status filter) and flip it
    // to pending — without this guard that would cancel an in-flight production
    // self-deploy mid-apply. The deploy is the consequence of a completed merge, not a
    // stale diff. Same exclusion as cancelChangeRuns.
    .where(and(eq(ciRuns.changeId, changeId), inArray(ciRuns.status, ["pending", "running"]), ne(ciRuns.commit, newHead), or(ne(ciRuns.origin, "merge"), isNull(ciRuns.origin))));
  const n = await cancelRuns(db, events, victims, "superseded");
  if (n) log("info", "runs_superseded_by_push", { changeId, newHead, canceled: n });
  return n;
}

/**
 * A change reached a terminal state (merged / abandoned / rolled_back): cancel ALL
 * its in-flight runs — a verify/CI run against a merged or abandoned change proves
 * nothing. Call from ChangeService on the state transition.
 */
export async function cancelChangeRuns(db: DB, events: EventBus, changeId: string, reason: TerminalReason = "stale"): Promise<number> {
  const victims = await db.select({ id: ciRuns.id, repoId: ciRuns.repoId, changeId: ciRuns.changeId, standingAgentId: ciRuns.standingAgentId, status: ciRuns.status })
    .from(ciRuns)
    // Cancel the VALIDATION runs (push CI + agent verify/review) that this terminal
    // change made pointless — but NEVER the merge→deploy run (origin='merge'), which
    // is the CONSEQUENCE of the merge, not stale work.
    .where(and(eq(ciRuns.changeId, changeId), inArray(ciRuns.status, ["pending", "running"]), or(ne(ciRuns.origin, "merge"), isNull(ciRuns.origin))));
  const n = await cancelRuns(db, events, victims, reason);
  if (n) log("info", "runs_canceled_change_terminal", { changeId, reason, canceled: n });
  return n;
}
