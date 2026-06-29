import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciPipelines, ciRuns, repositories } from "../models/schema.js";
import { recordStandingRunResult } from "./standing-agents.js";
import { namespaceNameOf } from "./namespace.js";
import type { EventBus } from "./events.js";
import { NotFoundError, AuthError, ValidationError, ConflictError } from "./errors.js";

const TERMINAL: ReadonlySet<string> = new Set(["success", "failure", "skipped"]);

export async function updateRunFromRunner(
  db: DB,
  events: EventBus,
  runId: string,
  runnerToken: string,
  body: { status: "running" | "success" | "failure" | "skipped"; logUrl?: string; stepResults?: unknown[] },
): Promise<void> {
  const run = (await db.select().from(ciRuns).where(eq(ciRuns.id, runId)).limit(1))[0];
  if (!run) throw new NotFoundError("ci run");
  if (run.runnerToken !== runnerToken) throw new AuthError("bad runner token");
  if (!["running", "success", "failure", "skipped"].includes(body.status)) throw new ValidationError("bad status");

  // "running" doubles as the claim: exactly one runner flips pending→running.
  // Anyone else reporting "running" gets a 409 and must drop the job. When the
  // run is in a concurrency group, the partial unique index (one running per
  // group) makes this flip fail with 23505 if a sibling in the group is already
  // running — atomically, no NOT-EXISTS race. We treat that as "group busy": the
  // run stays pending and is re-dispatched when the group frees (on terminal /
  // reap below), so the runner just drops it like any other lost claim.
  if (body.status === "running") {
    let claimed;
    try {
      claimed = await db.update(ciRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(and(eq(ciRuns.id, runId), eq(ciRuns.status, "pending")))
        .returning();
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictError("concurrency group busy");
      throw e;
    }
    if (!claimed.length) throw new ConflictError("run already claimed");
    await events.publish({ type: "ci.running", repoId: run.repoId, changeId: run.changeId ?? undefined, payload: { runId: run.id, status: "running" } });
    return;
  }

  const now = new Date();
  // The terminal transition is single-shot, like the "running" claim above: a
  // CAS that only fires when the run is NOT already terminal. The runner retries
  // terminal reports for ~60s (a self-deploy restarts the API mid-report), and
  // the reaper may finalize a stuck run just before a late real report arrives —
  // without this guard those duplicate/late reports would re-run all the side
  // effects below (double-count the failure breaker, resurrect a reaped run,
  // re-recompute, re-publish). Gate EVERY terminal side-effect on winning the CAS.
  const finalized = await db.update(ciRuns).set({
    status: body.status,
    logUrl: body.logUrl ?? run.logUrl,
    stepResults: body.stepResults ?? run.stepResults,
    startedAt: run.startedAt ?? now, // terminal report without a claim still gets a start time
    finishedAt: TERMINAL.has(body.status) ? now : run.finishedAt,
  }).where(and(eq(ciRuns.id, runId), notInArray(ciRuns.status, ["success", "failure", "skipped"]))).returning({ id: ciRuns.id });

  // Already finalized (duplicate/late report) — the winner already ran the side
  // effects; this report is an idempotent no-op (HTTP still 200 so the runner stops retrying).
  if (!finalized.length) return;

  if (run.changeId && TERMINAL.has(body.status)) {
    await recomputeChangeCiStatus(db, run.changeId);
  }

  // A standing-agent run terminating updates its agent: reset to idle on success,
  // else feed the failure counter (exponential backoff → circuit-breaker auto-
  // pause). Passes the runId so a stale run's report can't clobber a newer cycle.
  if (run.standingAgentId && TERMINAL.has(body.status)) {
    await recordStandingRunResult(db, run.standingAgentId, run.id, body.status === "failure" ? "failure" : "success");
  }

  await events.publish({
    type: TERMINAL.has(body.status) ? "ci.completed" : "ci.running",
    repoId: run.repoId, changeId: run.changeId ?? undefined,
    payload: { runId: run.id, status: body.status },
  });

  // A finished run frees its concurrency group — dispatch the next queued run in
  // it so the serialized queue drains.
  if (run.concurrencyGroup && TERMINAL.has(body.status)) {
    await dispatchNextInGroup(db, events, run.concurrencyGroup);
  }
}

/**
 * Drain a concurrency group after the run holding it finishes: pick the NEWEST
 * pending run in the group to run next, collapse any older pending runs in the
 * group to `skipped` (a backlog of merge→deploy runs only needs the latest — it
 * already contains the intermediate merges), and re-publish the chosen run's
 * `ci.run.queued` so a runner claims it. Best-effort: re-dispatch must never
 * throw out of a terminal report (which would make the runner retry forever).
 */
async function dispatchNextInGroup(db: DB, events: EventBus, group: string): Promise<void> {
  try {
    const pending = await db.select().from(ciRuns)
      .where(and(eq(ciRuns.concurrencyGroup, group), eq(ciRuns.status, "pending")))
      .orderBy(desc(ciRuns.createdAt));
    if (!pending.length) return;
    const [next, ...stale] = pending;

    if (stale.length) {
      await db.update(ciRuns).set({
        status: "skipped", finishedAt: new Date(),
        stepResults: [{ name: "concurrency", note: "superseded by a newer queued run in the same concurrency group" }],
      }).where(inArray(ciRuns.id, stale.map(r => r.id)));
      for (const s of stale) if (s.changeId) await recomputeChangeCiStatus(db, s.changeId);
    }

    // Rebuild the ci.run.queued payload the runner expects from the run + its
    // repo + pipeline (standing/no-pipeline runs aren't group-serialized today).
    const repo = (await db.select().from(repositories).where(eq(repositories.id, next.repoId)).limit(1))[0];
    const pipe = next.pipelineId ? (await db.select().from(ciPipelines).where(eq(ciPipelines.id, next.pipelineId)).limit(1))[0] : null;
    const ns = repo ? await namespaceNameOf(db, repo.namespaceType, repo.namespaceId) : null;
    if (!repo || !pipe || !ns) return;
    await events.publish({
      type: "ci.run.queued", repoId: next.repoId, changeId: next.changeId ?? undefined,
      actorKind: "system", actorId: "concurrency",
      payload: { runId: next.id, repoNs: ns, repoName: repo.name, commit: next.commit, pipelineYaml: pipe.yaml, runnerToken: next.runnerToken },
    });
  } catch (e) {
    // Swallow: a re-dispatch failure leaves the run pending; the next terminal in
    // the group (or the reaper) retries. Never abort the terminal report.
    void e;
  }
}

/**
 * Marks runs that will never finish as failures: a runner that died mid-run
 * leaves `running` rows, and a run no runner ever claimed sits `pending`
 * forever. Self-deploys make the first case routine — the deploy restarts the
 * API the runner reports to — so the runner retries terminal reports for a
 * minute; this sweep is the backstop when even that fails. Returns the number
 * of runs reaped.
 */
export async function reapStaleRuns(
  db: DB,
  events: EventBus,
  opts: { runningTimeoutMs?: number; pendingTimeoutMs?: number; standingRunningTimeoutMs?: number } = {},
): Promise<number> {
  const runningCutoff = new Date(Date.now() - (opts.runningTimeoutMs ?? Number(process.env.CLAWHUB_CI_RUNNING_TIMEOUT_MS ?? 15 * 60_000)));
  const pendingCutoff = new Date(Date.now() - (opts.pendingTimeoutMs ?? Number(process.env.CLAWHUB_CI_PENDING_TIMEOUT_MS ?? 60 * 60_000)));
  // A standing-agent loop legitimately runs far longer than a CI test, so it gets
  // a much longer running cutoff — reaping one at 15m would kill working agents.
  const standingRunningCutoff = new Date(Date.now() - (opts.standingRunningTimeoutMs ?? Number(process.env.CLAWHUB_STANDING_RUNNING_TIMEOUT_MS ?? 2 * 3600_000)));

  const reaped = await db.update(ciRuns)
    .set({ status: "failure", finishedAt: new Date(), stepResults: [{ name: "reaper", note: "no terminal report from any runner; marked failed by the stale-run sweep" }] })
    .where(or(
      and(eq(ciRuns.status, "running"), isNull(ciRuns.standingAgentId), lt(ciRuns.startedAt, runningCutoff)),
      and(eq(ciRuns.status, "running"), isNotNull(ciRuns.standingAgentId), lt(ciRuns.startedAt, standingRunningCutoff)),
      and(eq(ciRuns.status, "pending"), lt(ciRuns.createdAt, pendingCutoff)),
    ))
    .returning({ id: ciRuns.id, repoId: ciRuns.repoId, changeId: ciRuns.changeId, standingAgentId: ciRuns.standingAgentId, concurrencyGroup: ciRuns.concurrencyGroup });

  for (const run of reaped) {
    if (run.changeId) await recomputeChangeCiStatus(db, run.changeId);
    if (run.standingAgentId) {
      await recordStandingRunResult(db, run.standingAgentId, run.id, "failure", "run reaped: no terminal report (runner died or timed out)");
    }
    await events.publish({ type: "ci.completed", repoId: run.repoId, changeId: run.changeId ?? undefined, payload: { runId: run.id, status: "failure", reaped: true } });
    // Reaping a stuck run frees its concurrency group — drain the next queued one
    // so a dead deploy doesn't wedge the whole repo's deploy queue.
    if (run.concurrencyGroup) await dispatchNextInGroup(db, events, run.concurrencyGroup);
  }
  return reaped.length;
}

export async function recomputeChangeCiStatus(db: DB, changeId: string): Promise<void> {
  const all = await db.select().from(ciRuns).where(eq(ciRuns.changeId, changeId));
  // Only the newest run per pipeline counts. Runs from superseded heads stay
  // in history, but a failure there must not permanently block a Change
  // whose current head passes — push-fix-push has to converge to mergeable.
  const newest = new Map<string, (typeof all)[number]>();
  for (const r of all) {
    if (!r.pipelineId) continue; // standing runs carry no pipeline and never vote on a Change.
    const prev = newest.get(r.pipelineId);
    if (!prev || r.createdAt > prev.createdAt) newest.set(r.pipelineId, r);
  }
  const runs = [...newest.values()];
  let status: "pending" | "running" | "success" | "failure" | "skipped" = "pending";
  if (runs.length) {
    if (runs.some(r => r.status === "failure")) status = "failure";
    else if (runs.every(r => r.status === "success" || r.status === "skipped")) status = "success";
    else if (runs.some(r => r.status === "running")) status = "running";
    else status = "pending";
  }
  await db.update(changes).set({ ciStatus: status }).where(eq(changes.id, changeId));
}
