import { and, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns, standingAgents, verificationRuns } from "../models/schema.js";
import type { EventBus, ClawHubEvent } from "./events.js";
import { cronDue } from "./cron.js";
import { continuousDue, dispatchStandingRun, quietDue, republishStalePendingStandingRuns } from "./standing-agents.js";
import { maybeDispatchNativeReview } from "./native-reviewer.js";
import { maybeDispatchNativeVerify } from "./native-verifier.js";
import { isCiOriginatedEvent } from "./event-pipeline-trigger.js";
import { republishStalePendingPipelineRuns } from "./ci-trigger.js";
import { schedulerPass } from "./run-scheduler.js";
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
  // At-least-once for PIPELINE CI runs too (push/schedule/event) — a missed ci.run.queued
  // frame (runner stream down during a deploy restart) would otherwise strand the run;
  // the harness arm64 build leg is the sharp case. The runner's atomic claim de-dups.
  await republishStalePendingPipelineRuns(db, events, now).catch(e => log("warn", "pipeline_republish_failed", { err: (e as Error).message }));
  // Reconcile changes whose verify dispatch was MISSED (reviewer busy / API restart) —
  // green CI but no attestation, silently stranded. Re-pokes them so the loop can't
  // permanently stall on a hiccup. Best-effort, throttled.
  await reconcileUnverifiedChanges(db, events, now).catch(e => log("warn", "standing_reconcile_failed", { err: (e as Error).message }));
  // Unified async-job scheduler pass (docs/job-scheduler-design.md): order the pending
  // ci_runs backlog by priority + aging and place each onto a resource-feasible node
  // (spread, keeping heavy tiers off the prod-co-located box). Inert unless
  // CLAWHUB_SCHEDULER_ENABLED=shadow|on; fast-exits on an empty backlog or dead nodes.
  await schedulerPass(db, now).catch(e => log("warn", "scheduler_pass_failed", { err: (e as Error).message }));

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
    if (sa.trigger === "quiet") {
      // Debounce-until-quiet (reflect's natural cadence): fire once per burst of
      // repo activity, after it settles for intervalSec. Activity = the newest
      // change touch (open/update/merge/rollback all bump changes.updatedAt) —
      // EXCLUDING changes this agent itself opened: a reflect run pushes its
      // .clawhub/memory update as a new Change, which would otherwise re-arm the
      // trigger and loop reflect forever on an idle repo.
      const [act] = await db.select({ last: sql<string | Date | null>`max(${changes.updatedAt})` })
        .from(changes).where(and(
          eq(changes.repoId, sa.repoId),
          sql`${changes.openedByAgentId} is distinct from ${sa.agentId}`,
        ));
      const lastActivity = act?.last ? new Date(act.last) : null;
      if (!quietDue(lastActivity, sa.lastRunAt, sa.intervalSec, now, sa.nextEligibleAt)) continue;
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

// How long a change waits between reconcile re-pokes — long enough for a dispatched
// verify to boot + run before we'd consider re-poking it.
const RECONCILE_THROTTLE_MS = 10 * 60_000;

/**
 * Reconcile PUBLISHED, open changes that have green CI but NO success verification for
 * their current head, on repos that actually run a verify/review reviewer. Their
 * change-event verify dispatch was missed (the reviewer was in-flight on another
 * change, or the API restarted mid-event) and nothing else retries it — so the change
 * silently strands: green CI, no attestation, never auto-merged, never surfaced.
 *
 * We re-emit `change.updated`, which `handleEventForStandingAgents` picks up and
 * re-dispatches the HEAD-PINNED verify (its per-agent in-flight dedup makes this safe
 * to run every tick). Throttled per-change (skip if a reviewer run is pending/running
 * or was dispatched within RECONCILE_THROTTLE_MS) so we never pile on.
 */
export async function reconcileUnverifiedChanges(db: DB, events: EventBus, now: Date = new Date()): Promise<number> {
  // Only repos with an enabled event-driven verify/review reviewer are reconcilable.
  const reviewerRepos = [...new Set((await db.select({ repoId: standingAgents.repoId }).from(standingAgents)
    .where(and(eq(standingAgents.enabled, true), eq(standingAgents.trigger, "event"),
      inArray(standingAgents.mode, ["verify", "review"])))).map(r => r.repoId))];
  if (!reviewerRepos.length) return 0;

  const since = new Date(now.getTime() - 24 * 3600_000); // don't chase ancient changes
  const throttle = new Date(now.getTime() - RECONCILE_THROTTLE_MS);
  const candidates = await db.select({ id: changes.id, repoId: changes.repoId, head: changes.headCommit })
    .from(changes)
    .where(and(
      inArray(changes.status, ["pending", "approved"]),
      eq(changes.isDraft, false),
      eq(changes.ciStatus, "success"),
      inArray(changes.repoId, reviewerRepos),
      gt(changes.updatedAt, since),
    )).limit(200);

  let dispatched = 0;
  for (const ch of candidates) {
    // Already verified for the CURRENT head → nothing to reconcile.
    const att = (await db.select({ id: verificationRuns.id }).from(verificationRuns)
      .where(and(eq(verificationRuns.changeId, ch.id), eq(verificationRuns.headCommit, ch.head), eq(verificationRuns.status, "success"))).limit(1))[0];
    if (att) continue;
    // A reviewer run is already in-flight or was dispatched inside the throttle window
    // → give it time to finish instead of re-poking.
    const inflight = (await db.select({ id: ciRuns.id }).from(ciRuns)
      .where(and(eq(ciRuns.changeId, ch.id), isNotNull(ciRuns.standingAgentId),
        or(inArray(ciRuns.status, ["pending", "running"]), gt(ciRuns.createdAt, throttle)))).limit(1))[0];
    if (inflight) continue;
    await events.publish({ type: "change.updated", repoId: ch.repoId, changeId: ch.id, payload: { reconciled: true } }).catch(() => { /* best-effort */ });
    dispatched++;
  }
  if (dispatched) log("info", "standing_reconcile_dispatched", { count: dispatched });
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
  // A magic-ref push (refs/for/<branch>) creates the Change via the ref-rewriter
  // BEFORE post-push runs, so post-push sees it as existing and emits change.updated
  // for a brand-new Change — and a re-push to an open Change SHOULD re-trigger a
  // reviewer anyway. So a change.updated also satisfies a change.opened subscription
  // (and vice-versa): an agent watching for either fires on both. The per-agent
  // in-flight dedup keeps a burst of change events from double-running.
  // change.ready (a draft being published) joins the family so a reviewer watching
  // change.opened ALSO fires the moment a draft is published — its diff is now final.
  const CHANGE_EVENTS = ["change.opened", "change.updated", "change.ready"];
  const matchTypes = CHANGE_EVENTS.includes(e.type) ? CHANGE_EVENTS : [e.type];
  const rows = await db.select().from(standingAgents).where(and(
    eq(standingAgents.repoId, e.repoId),
    eq(standingAgents.enabled, true),
    eq(standingAgents.trigger, "event"),
    inArray(standingAgents.event, matchTypes),
    // System agents (the native reviewer) are dispatched by their own gated path
    // (maybeDispatchNativeReview) with per-change model selection — exclude them
    // here so a provisioned reviewer isn't ALSO run by the generic BYO loop.
    eq(standingAgents.isSystem, false),
  ));
  let dispatched = 0;
  const now = Date.now();
  // For a change-scoped event (change.opened etc.), bind the run to the change's
  // EXACT head so a verify-mode reviewer's attestation matches it (verified
  // autonomy keys off run.commit === change.headCommit). Resolved once per event.
  let changeBinding: { commit: string; changeId: string } | undefined;
  let changeIsDraft = false;
  let changeRow: typeof changes.$inferSelect | undefined;
  if (e.changeId) {
    changeRow = (await db.select().from(changes).where(eq(changes.id, e.changeId)).limit(1))[0];
    if (changeRow) { changeBinding = { commit: changeRow.headCommit, changeId: changeRow.id }; changeIsDraft = changeRow.isDraft; }
  }
  // Native advisory reviewer (M4): its own gated, model-selecting dispatch path,
  // separate from the BYO loop below. Only for published change events. Best-effort.
  if (changeRow && !changeIsDraft && CHANGE_EVENTS.includes(e.type)) {
    void maybeDispatchNativeReview(db, events, changeRow);
    // Platform-keyed verify (D10) — its own gated path (repo opt-in + paid + credits).
    void maybeDispatchNativeVerify(db, events, changeRow);
  }
  for (const sa of rows) {
    // Honor the failure-backoff hold for event-triggered agents too — a failing
    // agent stops reacting to every event while it backs off.
    if (sa.nextEligibleAt && now < sa.nextEligibleAt.getTime()) continue;
    // Reviewers (verify/review) run only on PUBLISHED diffs — skip a draft Change.
    // Publishing it emits change.ready (isDraft=false here), which re-dispatches them.
    if (changeIsDraft && (sa.mode === "verify" || sa.mode === "review")) continue;
    const r = await dispatchStandingRun(db, events, sa, changeBinding ?? {});
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
