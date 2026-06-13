import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines } from "../models/schema.js";
import type { ClawHubEvent, EventBus } from "./events.js";
import { enqueueTriggeredRun, resolveRepoTarget } from "./ci-trigger.js";
import { log } from "./logger.js";

// Event-triggered CI fan-out. Wired from app.ts: on each published event, find
// enabled triggerKind='event' pipelines in that event's repo whose
// triggerConfig.event === event.type and enqueue a run at default-branch HEAD,
// via the SAME ci.run.queued payload the push path uses (ci-trigger.ts).
//
// LOOP GUARD — an event-triggered run emits its own events (ci.run.queued while
// queueing, ci.running / ci.completed as it executes, plus change.* if the job
// opens or merges a Change). Without guards those events would retrigger
// pipelines forever. Three layers, documented at each site:
//
//   (a) HERE — never let ci.* events drive event-pipelines that themselves
//       produce ci.* runs. We refuse to fan out for any event whose type starts
//       with "ci." (ci.run.queued, ci.running, ci.completed, ...). That breaks
//       the tightest cycle: an event run completing → ci.completed → another run.
//       Non-ci events (change.merged, issue.opened, ...) are still honored.
//
//   (b) ci-trigger.ts — depth cap: runs enqueued here carry triggerDepth=1, and
//       enqueueTriggeredRun refuses depth > 1. Since the only events an event
//       run can emit that we still honor are change.* (a job that opens/merges a
//       Change), those would arrive to fan out again at depth 2 — and are
//       refused. So a change.* echo from a depth-1 run cannot spawn a depth-2 run.
//
//   (c) ci-trigger.ts — de-dup: an identical (pipeline, commit, triggerEvent)
//       run already pending/running is not re-enqueued, collapsing event bursts.
//
// SECURITY: event runs hold a per-run runnerToken exactly like push/merge runs —
// same trust model, no new privilege, and they never merge anything (the merge
// gate stays human-policed). See ci-trigger.ts.

const CI_EVENT_PREFIX = "ci.";

/** True if this event type must not drive event-pipelines (guard (a)). */
export function isCiOriginatedEvent(type: string): boolean {
  return type.startsWith(CI_EVENT_PREFIX);
}

/** Handle one event: enqueue matching event-pipeline runs. Exposed for tests. */
export async function handleEventForPipelines(db: DB, events: EventBus, e: ClawHubEvent): Promise<number> {
  if (!e.repoId || !e.type) return 0;
  // Guard (a): ci.* events never fan out — that is the cycle they would close.
  if (isCiOriginatedEvent(e.type)) return 0;

  const matches = (await db.select().from(ciPipelines).where(and(
    eq(ciPipelines.repoId, e.repoId),
    eq(ciPipelines.enabled, true),
    eq(ciPipelines.triggerKind, "event"),
  ))).filter(p => (p.triggerConfig as { event?: string } | null)?.event === e.type);
  if (matches.length === 0) return 0;

  const target = await resolveRepoTarget(db, e.repoId);
  if (!target) { log("warn", "event_target_unresolved", { repoId: e.repoId, event: e.type }); return 0; }

  let enqueued = 0;
  for (const p of matches) {
    try {
      // triggerDepth=1: one hop from the originating event. enqueueTriggeredRun
      // refuses anything > 1, so cascades cannot deepen.
      const runId = await enqueueTriggeredRun(db, events, p, target, { origin: "event", triggerDepth: 1, triggerEvent: e.type });
      if (runId) { enqueued++; log("info", "ci_event_run_queued", { pipelineId: p.id, runId, event: e.type, commit: target.commit }); }
    } catch (err) {
      log("warn", "event_enqueue_failed", { pipelineId: p.id, err: (err as Error).message });
    }
  }
  return enqueued;
}

/** Subscribe to the event bus and fan out event-pipeline runs. Returns the unsubscribe fn. */
export function wireEventPipelineTriggers(db: DB, events: EventBus): () => void {
  return events.onEvent(e => {
    handleEventForPipelines(db, events, e).catch(err => log("warn", "event_pipeline_fanout_failed", { err: (err as Error).message }));
  });
}
