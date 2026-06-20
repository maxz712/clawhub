import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { standingAgents } from "../models/schema.js";
import type { EventBus, ClawHubEvent } from "./events.js";
import { cronDue } from "./cron.js";
import { continuousDue, dispatchStandingRun, republishStalePendingStandingRuns } from "./standing-agents.js";
import { isCiOriginatedEvent } from "./event-pipeline-trigger.js";
import { log } from "./logger.js";

// Standing-agent trigger driver. Mirrors pipeline-scheduler.ts:
//   continuous → due when now - lastRunAt >= intervalSec (or never run)
//   schedule   → due when a 5-field UTC cron tick elapsed (cronDue), claimed via
//                a compare-and-swap on lastScheduledAt so overlapping loops /
//                processes can't double-fire
//   event      → fired from the event bus (wireStandingAgentEvents)
// In all cases the actual dispatch (dispatchStandingRun) re-checks the kill
// switch, cost budget, in-flight, and rate cap — the tick only decides timing.

/** Run one continuous+schedule tick. Returns the number of runs dispatched. */
export async function runStandingTick(db: DB, events: EventBus, now: Date = new Date()): Promise<number> {
  // At-least-once delivery: re-publish any standing run still pending + unclaimed
  // past the window (runner was offline, or API crashed after insert). The
  // runner's atomic claim de-dups, so this is safe to run every tick.
  await republishStalePendingStandingRuns(db, events, now).catch(e => log("warn", "standing_republish_failed", { err: (e as Error).message }));

  const rows = await db.select().from(standingAgents).where(eq(standingAgents.enabled, true));
  let dispatched = 0;
  for (const sa of rows) {
    if (sa.trigger === "continuous") {
      // Respects the failure-backoff hold (nextEligibleAt) as well as the interval.
      if (!continuousDue(sa.lastRunAt, sa.intervalSec, now, sa.nextEligibleAt)) continue;
      const r = await dispatchStandingRun(db, events, sa);
      if (r.ok) dispatched++;
      continue;
    }
    if (sa.trigger === "schedule") {
      if (!sa.cron) continue;
      // Honor the failure-backoff hold on schedule ticks too (not just continuous),
      // so a failing scheduled agent backs off before the breaker trips.
      if (sa.nextEligibleAt && now.getTime() < sa.nextEligibleAt.getTime()) continue;
      // Self-heal a future lastScheduledAt (clock skew / manual edit), else
      // cronDue would never fire again. Mirrors pipeline-scheduler.
      if (sa.lastScheduledAt && sa.lastScheduledAt.getTime() > now.getTime()) {
        await db.update(standingAgents).set({ lastScheduledAt: now }).where(eq(standingAgents.id, sa.id));
        continue;
      }
      let due = false;
      try { due = cronDue(sa.cron, sa.lastScheduledAt ?? null, now); }
      catch (e) { log("warn", "standing_cron_parse_failed", { id: sa.id, err: (e as Error).message }); continue; }
      if (!due) continue;
      // Compare-and-swap claim — only the loop whose read still matches wins.
      const prev = sa.lastScheduledAt;
      const claim = await db.update(standingAgents)
        .set({ lastScheduledAt: now })
        .where(and(
          eq(standingAgents.id, sa.id),
          prev === null ? sql`${standingAgents.lastScheduledAt} is null` : eq(standingAgents.lastScheduledAt, prev),
        ))
        .returning({ id: standingAgents.id });
      if (claim.length === 0) continue;
      const r = await dispatchStandingRun(db, events, sa);
      if (r.ok) dispatched++;
    }
  }
  return dispatched;
}

/**
 * Start the continuous+schedule loop. Returns a stop function. The timer is
 * unref'd so it never keeps the process alive on its own.
 */
export function startStandingAgentScheduler(db: DB, events: EventBus, intervalMs = 60_000): () => void {
  const timer = setInterval(() => {
    runStandingTick(db, events)
      .then(n => { if (n > 0) log("info", "standing_scheduler_tick", { dispatched: n }); })
      .catch(() => { /* next tick retries */ });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Dispatch event-triggered standing agents for one event. Returns count dispatched. */
export async function handleEventForStandingAgents(db: DB, events: EventBus, e: ClawHubEvent): Promise<number> {
  if (!e.repoId || !e.type) return 0;
  // Guard (a): an agent's own run-completion (ci.*) must not retrigger it.
  if (isCiOriginatedEvent(e.type)) return 0;
  const rows = await db.select().from(standingAgents).where(and(
    eq(standingAgents.repoId, e.repoId),
    eq(standingAgents.enabled, true),
    eq(standingAgents.trigger, "event"),
    eq(standingAgents.event, e.type),
  ));
  let dispatched = 0;
  const now = Date.now();
  for (const sa of rows) {
    // Honor the failure-backoff hold for event-triggered agents too — a failing
    // agent stops reacting to every event while it backs off.
    if (sa.nextEligibleAt && now < sa.nextEligibleAt.getTime()) continue;
    const r = await dispatchStandingRun(db, events, sa);
    if (r.ok) dispatched++;
  }
  return dispatched;
}

/** Subscribe standing agents to the event bus. Returns an unsubscribe function. */
export function wireStandingAgentEvents(db: DB, events: EventBus): () => void {
  return events.onEvent(e => {
    handleEventForStandingAgents(db, events, e).catch(err => log("warn", "standing_event_dispatch_failed", { type: e.type, err: (err as Error).message }));
  });
}
