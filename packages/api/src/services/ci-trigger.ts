import { and, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, ciPipelines, ciRuns, repositories } from "../models/schema.js";
import type { EventBus } from "./events.js";
import type { CiPipeline } from "../models/schema.js";
import { randomToken } from "./auth.js";
import { log } from "./logger.js";
import { namespaceNameOf } from "./namespace.js";
import { parsePipelineTrigger } from "./ci-yaml.js";
import { resolveCiExecution } from "./ci-host-exec.js";
import { ciSchedulingStamp } from "./job-scheduling.js";

// Shared enqueue path for schedule- and event-triggered CI runs.
//
// SECURITY / TRUST MODEL: a scheduled or event run executes the same arbitrary
// pipeline steps on the runner, holding the SAME per-run `runnerToken`, as a
// push- or merge-triggered run. No new privilege is granted: the token stays
// per-run (minted fresh here, never reused) and only unlocks that one run's
// secrets while it is non-terminal (see routes/ci.ts GET /runs/:id/secrets).
// These jobs do NOT merge anything. If a triggered job opens a Change, that
// Change still flows through the normal human-gated merge policy — the trigger
// cannot self-approve or bypass review.

/** A pipeline targeted at the repo's default-branch HEAD. */
interface RepoTarget {
  ns: string;
  repoName: string;
  commit: string; // default-branch HEAD SHA
}

/**
 * Resolve a repo's namespace name + default-branch HEAD commit. Returns null if
 * the repo, its namespace, or its default-branch ref cannot be resolved — the
 * scheduler/fan-out then skips it rather than enqueueing a run with no commit.
 */
export async function resolveRepoTarget(db: DB, repoId: string): Promise<RepoTarget | null> {
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!repo) return null;
  const nsName = await namespaceNameOf(db, repo.namespaceType, repo.namespaceId);
  if (!nsName) return null;
  // Default-branch HEAD comes from the branches table (kept current by the push
  // pipeline) — no git process spawned on the hot scheduler loop.
  const head = (await db.select({ headCommit: branches.headCommit }).from(branches)
    .where(and(eq(branches.repoId, repoId), eq(branches.name, repo.defaultBranch))).limit(1))[0]?.headCommit;
  if (!head) return null;
  return { ns: nsName, repoName: repo.name, commit: head };
}

export interface TriggeredEnqueue {
  origin: "schedule" | "event";
  /** Trigger hop count. Push/merge are 0; an event-triggered run is 1. */
  triggerDepth: number;
  /** Event type that produced this run (event triggers only). */
  triggerEvent?: string;
}

/** The hard ceiling on trigger hops. Push/merge/schedule originate at 0; an event run is 1. */
export const MAX_TRIGGER_DEPTH = 1;

// Rate cap: the depth cap + per-commit de-dup do NOT bound a cascade whose every
// hop produces a NEW commit (e.g. an `on: event` pipeline whose steps push to the
// default branch → new push event → new commit → de-dup miss → loop). The cap
// bounds ANY such cascade by hard-limiting how often a single pipeline may be
// triggered in a window, independent of how the loop forms. A legitimate
// once-a-minute schedule is 10 runs / 10 min, comfortably under the ceiling.
export const TRIGGER_RATE_CAP = 20;
export const TRIGGER_RATE_WINDOW_MS = 10 * 60_000;
// Per-repo aggregate ceiling — bounds the cross-pipeline multiplication a
// per-pipeline cap allows (many `on: event` pipelines in one repo). Flat per
// repo regardless of pipeline count, so a repo can't exhaust the runner fleet.
export const REPO_TRIGGER_RATE_CAP = 60;

/** Pure: is a pipeline under its triggered-run rate cap given its recent count? */
export function withinTriggerRateCap(recentTriggeredCount: number): boolean {
  return recentTriggeredCount < TRIGGER_RATE_CAP;
}

/** Pure: is a repo under its aggregate triggered-run rate cap? */
export function withinRepoTriggerRateCap(recentRepoTriggeredCount: number): boolean {
  return recentRepoTriggeredCount < REPO_TRIGGER_RATE_CAP;
}

/** A live (pending/running) run as seen by the de-dup check. */
export interface LiveRun {
  triggerEvent: string | null;
}

/**
 * Pure loop-guard decision (no DB): may we enqueue a triggered run given its
 * depth and the set of already-live runs for the same (pipeline, commit)?
 *
 *  (b) depth cap — refuse when triggerDepth would exceed MAX_TRIGGER_DEPTH.
 *  (c) de-dup — refuse if a live run already carries the same triggerEvent.
 *
 * Exposed so the guard can be unit-tested without standing up a database.
 */
export function shouldEnqueueTriggered(meta: TriggeredEnqueue, live: LiveRun[]): boolean {
  if (meta.triggerDepth > MAX_TRIGGER_DEPTH) return false;
  const want = meta.triggerEvent ?? null;
  if (live.some(r => (r.triggerEvent ?? null) === want)) return false;
  return true;
}

/**
 * Enqueue one CI run for a pipeline at the repo default-branch HEAD, reusing the
 * EXACT `ci.run.queued` payload shape the push/merge paths publish so the runner
 * needs zero changes. Returns the run id, or null if it was skipped (target
 * unresolved, depth exceeded, or an identical run already pending/running).
 *
 * LOOP GUARD (event triggers can emit events that retrigger pipelines):
 *  (b) depth cap — refuse when triggerDepth would exceed 1, so a cascade dies
 *      after a single hop even if (a)/(c) are somehow defeated.
 *  (c) de-dup — refuse if an identical (pipeline, commit, triggerEvent) run is
 *      already pending or running, so a burst of the same event collapses to one.
 * Guard (a) — never letting ci.* events trigger ci-producing pipelines — lives
 * at the fan-out site in app.ts (it filters the event type before calling here).
 */
export async function enqueueTriggeredRun(
  db: DB,
  events: EventBus,
  pipeline: CiPipeline,
  target: RepoTarget,
  meta: TriggeredEnqueue,
): Promise<string | null> {
  // (b)+(c) Loop guard: depth cap + de-dup against already-live runs for the
  // same (pipeline, commit). Read the live set, then defer to the pure decision.
  const live = await db.select({ triggerEvent: ciRuns.triggerEvent }).from(ciRuns).where(and(
    eq(ciRuns.pipelineId, pipeline.id),
    eq(ciRuns.commit, target.commit),
    inArray(ciRuns.status, ["pending", "running"]),
  ));
  if (!shouldEnqueueTriggered(meta, live)) {
    if (meta.triggerDepth > MAX_TRIGGER_DEPTH) log("warn", "ci_trigger_depth_exceeded", { pipelineId: pipeline.id, depth: meta.triggerDepth });
    return null;
  }

  // Rate cap — the backstop that bounds commit-churning cascades the depth/de-dup
  // guards can't see. Count this pipeline's recent triggered runs; refuse past the
  // ceiling. This is the guard that does not depend on tracking depth across the
  // runner round-trip, so it holds even if the origin/depth marker is ever lost.
  const since = new Date(Date.now() - TRIGGER_RATE_WINDOW_MS);
  const recent = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns).where(and(
    eq(ciRuns.pipelineId, pipeline.id),
    inArray(ciRuns.origin, ["schedule", "event"]),
    gte(ciRuns.createdAt, since),
  ));
  if (!withinTriggerRateCap(Number(recent[0]?.n ?? 0))) {
    log("warn", "ci_trigger_rate_capped", { pipelineId: pipeline.id, cap: TRIGGER_RATE_CAP, windowMs: TRIGGER_RATE_WINDOW_MS });
    return null;
  }
  // Repo-level aggregate cap: bounds the multiplication of many event pipelines
  // in one repo, so a single repo can't exhaust the shared runner fleet.
  const repoRecent = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns).where(and(
    eq(ciRuns.repoId, pipeline.repoId),
    inArray(ciRuns.origin, ["schedule", "event"]),
    gte(ciRuns.createdAt, since),
  ));
  if (!withinRepoTriggerRateCap(Number(repoRecent[0]?.n ?? 0))) {
    log("warn", "ci_trigger_repo_rate_capped", { repoId: pipeline.repoId, cap: REPO_TRIGGER_RATE_CAP, windowMs: TRIGGER_RATE_WINDOW_MS });
    return null;
  }

  const runnerToken = randomToken(18);
  // Arch pin (from the pipeline's `runs_on:`): forwarded so the runner claims the run
  // only on a matching-arch box. Absent → any runner may claim (fail-safe default).
  // Resolved before the insert so it is persisted on the run (survives re-dispatch)
  // AND feeds the scheduler stamp.
  const runsOn = (pipeline.triggerConfig as { runsOn?: string } | null | undefined)?.runsOn ?? null;
  let run;
  try {
    run = (await db.insert(ciRuns).values({
      repoId: pipeline.repoId,
      pipelineId: pipeline.id,
      runnerToken,
      origin: meta.origin,
      triggerDepth: meta.triggerDepth,
      triggerEvent: meta.triggerEvent,
      commit: target.commit,
      // Scheduler stamp: schedule/event CI runs at the on:push band (they gate/deploy
      // off the default branch head); persists priority + resource request + arch pin.
      ...ciSchedulingStamp(meta.origin, { runsOn }),
      // changeId stays null: schedule/event runs target the default branch head,
      // not a Change. They never vote on a Change's ciStatus.
    }).returning())[0];
  } catch (e) {
    // Concurrent duplicate (two API replicas, or an event double-delivered by the
    // in-process + Redis-poll paths) collides on the partial unique index over
    // (pipeline, commit, trigger_event) WHERE status='pending'. The loser treats
    // it as already-enqueued rather than inserting a second run.
    if ((e as { code?: string }).code === "23505") {
      log("info", "ci_trigger_dedup_race", { pipelineId: pipeline.id, commit: target.commit, event: meta.triggerEvent });
      return null;
    }
    throw e;
  }

  // Capability-graded execution (covers on:event/on:schedule — incl. the harness-build
  // matrix that needs host): host only for an operator-allowlisted repo that requested
  // `execution: host`; else contained. Resolved server-side; runner obeys the stamp, not
  // the YAML. A missed site here would reopen host exec via schedule/event. See ci-host-exec.ts.
  const execution = resolveCiExecution(parsePipelineTrigger(pipeline.yaml).config.execution, target.ns, target.repoName, pipeline.repoId);
  await events.publish({
    type: "ci.run.queued",
    repoId: pipeline.repoId,
    // No changeId — same omission the runner already tolerates for non-Change runs.
    actorKind: "system",
    actorId: meta.origin,
    payload: { runId: run.id, repoNs: target.ns, repoName: target.repoName, commit: target.commit, pipelineYaml: pipeline.yaml, runnerToken, execution, ...(runsOn ? { runsOn } : {}) },
  });
  return run.id;
}

// A pending pipeline CI run (push/schedule/event) reaches the runner via a SINGLE
// ci.run.queued SSE frame — which the runner MISSES if its stream is down when the
// frame fires (an API restart during a self-deploy, backpressure on a busy box). Unlike
// standing runs (republishStalePendingStandingRuns) there was NO redelivery for these,
// so a missed frame stranded the run forever. The sharp case: the harness arm64 build
// leg runs on the OCI box that the deploy restarts, so its frame is exactly the one at
// risk — and a lost arm64 run means the amd64 fuse hard-fails and :latest goes stale
// with no recovery. This re-publishes stale UNCLAIMED pending pipeline runs so the
// runner's atomic claim can still pick them up. Safe every tick: a claimed run has
// startedAt set (skipped) and the atomic claim de-dups a double-delivery; a run blocked
// on its concurrency group just fails the claim and stays pending.
export const PIPELINE_REPUBLISH_AFTER_MS = Number(process.env.CLAWHUB_PIPELINE_REPUBLISH_AFTER_MS ?? 120_000);
export async function republishStalePendingPipelineRuns(db: DB, events: EventBus, now: Date = new Date(), limit = 50): Promise<number> {
  const cutoff = new Date(now.getTime() - PIPELINE_REPUBLISH_AFTER_MS);
  const stale = await db.select().from(ciRuns).where(and(
    isNotNull(ciRuns.pipelineId),
    isNull(ciRuns.standingAgentId),   // standing runs have their own republisher
    eq(ciRuns.status, "pending"),
    isNull(ciRuns.startedAt),          // never claimed by a runner
    lt(ciRuns.createdAt, cutoff),
  )).limit(limit);
  let n = 0;
  for (const run of stale) {
    const pipeline = (await db.select().from(ciPipelines).where(eq(ciPipelines.id, run.pipelineId!)).limit(1))[0];
    if (!pipeline) continue;
    const target = await resolveRepoTarget(db, run.repoId);
    if (!target || !run.commit) continue;
    const runsOn = (pipeline.triggerConfig as { runsOn?: string } | null | undefined)?.runsOn;
    const execution = resolveCiExecution(parsePipelineTrigger(pipeline.yaml).config.execution, target.ns, target.repoName, run.repoId);
    await events.publish({
      type: "ci.run.queued", repoId: run.repoId, actorKind: "system", actorId: "pipeline-run-republish",
      // The run's ORIGINAL commit + runnerToken (not the current head) — same payload the
      // enqueue published, so the runner resumes the exact run.
      payload: { runId: run.id, repoNs: target.ns, repoName: target.repoName, commit: run.commit, pipelineYaml: pipeline.yaml, runnerToken: run.runnerToken, execution, ...(runsOn ? { runsOn } : {}) },
    });
    n++;
  }
  if (n) log("info", "pipeline_runs_republished", { count: n });
  return n;
}
