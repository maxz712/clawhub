import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { cronDue } from "./cron.js";
import { enqueueTriggeredRun, resolveRepoTarget } from "./ci-trigger.js";
import { log } from "./logger.js";

// Scheduled-pipeline driver. Started from app.ts via setInterval(~60s).unref().
//
// Each tick finds enabled triggerKind='schedule' pipelines, asks cron.cronDue
// whether a tick fired in (lastScheduledRunAt, now] (all UTC), and for each due
// pipeline enqueues a CI run at the repo's default-branch HEAD via the SAME
// payload the push path publishes (services/ci-trigger.ts → ci.run.queued).
//
// DOUBLE-FIRE SAFETY across overlapping 60s loops (or multiple API processes):
// before enqueueing we claim the tick with a CONDITIONAL update that sets
// lastScheduledRunAt=now only if the row's lastScheduledRunAt still equals the
// value we read (compare-and-swap). Exactly one loop wins the claim; the loser's
// WHERE matches zero rows and it skips. The enqueue happens only after the claim
// succeeds, so a due pipeline fires at most once per minute even under races.
//
// SECURITY: scheduled runs hold a per-run runnerToken exactly like push/merge
// runs — same trust model, no new privilege, and they never merge (see
// ci-trigger.ts). A schedule that opens a Change still goes through human-gated
// merge policy.

/** Run one scheduler pass. Returns the number of runs enqueued. Exposed for tests. */
export async function runSchedulerTick(db: DB, events: EventBus, now: Date = new Date()): Promise<number> {
  const due = await db.select().from(ciPipelines).where(and(
    eq(ciPipelines.enabled, true),
    eq(ciPipelines.triggerKind, "schedule"),
  ));
  let enqueued = 0;
  for (const p of due) {
    const cron = (p.triggerConfig as { cron?: string } | null)?.cron;
    if (!cron) continue; // schedule pipeline with no cron is inert.

    // Self-heal a future lastScheduledRunAt (clock skew, a fast-clocked replica,
    // or a manual edit). Left alone, cronDue would silently never fire again
    // until wall-clock caught up. Reset to now and resume on the next tick.
    if (p.lastScheduledRunAt && p.lastScheduledRunAt.getTime() > now.getTime()) {
      log("warn", "schedule_future_timestamp_reset", { pipelineId: p.id, was: p.lastScheduledRunAt.toISOString() });
      await db.update(ciPipelines).set({ lastScheduledRunAt: now }).where(eq(ciPipelines.id, p.id));
      continue;
    }

    let isDue = false;
    try { isDue = cronDue(cron, p.lastScheduledRunAt ?? null, now); }
    catch (e) { log("warn", "cron_parse_failed", { pipelineId: p.id, err: (e as Error).message }); continue; }
    if (!isDue) continue;

    // Compare-and-swap claim: only the loop whose read still matches wins.
    // `is null` handles the first-ever fire (lastScheduledRunAt was null).
    const prev = p.lastScheduledRunAt;
    const claim = await db.update(ciPipelines)
      .set({ lastScheduledRunAt: now })
      .where(and(
        eq(ciPipelines.id, p.id),
        prev === null ? sql`${ciPipelines.lastScheduledRunAt} is null` : eq(ciPipelines.lastScheduledRunAt, prev),
      ))
      .returning({ id: ciPipelines.id });
    if (claim.length === 0) continue; // another loop already claimed this tick.

    const target = await resolveRepoTarget(db, p.repoId);
    if (!target) { log("warn", "schedule_target_unresolved", { pipelineId: p.id, repoId: p.repoId }); continue; }

    try {
      const runId = await enqueueTriggeredRun(db, events, p, target, { origin: "schedule", triggerDepth: 0 });
      if (runId) { enqueued++; log("info", "ci_scheduled_run_queued", { pipelineId: p.id, runId, commit: target.commit }); }
    } catch (e) {
      log("warn", "schedule_enqueue_failed", { pipelineId: p.id, err: (e as Error).message });
    }
  }
  return enqueued;
}

/**
 * Start the scheduler loop. Returns a stop function. The timer is unref'd so it
 * never keeps the process alive on its own, matching the stale-run reaper.
 */
export function startPipelineScheduler(db: DB, events: EventBus, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    runSchedulerTick(db, events)
      .then(n => { if (n > 0) log("info", "ci_scheduler_tick", { enqueued: n }); })
      .catch(() => { /* next tick retries */ });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
