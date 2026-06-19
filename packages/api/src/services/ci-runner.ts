import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns } from "../models/schema.js";
import { recordStandingRunResult } from "./standing-agents.js";
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
  // Anyone else reporting "running" gets a 409 and must drop the job.
  if (body.status === "running") {
    const claimed = await db.update(ciRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(ciRuns.id, runId), eq(ciRuns.status, "pending")))
      .returning();
    if (!claimed.length) throw new ConflictError("run already claimed");
    await events.publish({ type: "ci.running", repoId: run.repoId, changeId: run.changeId ?? undefined, payload: { runId: run.id, status: "running" } });
    return;
  }

  const now = new Date();
  await db.update(ciRuns).set({
    status: body.status,
    logUrl: body.logUrl ?? run.logUrl,
    stepResults: body.stepResults ?? run.stepResults,
    startedAt: run.startedAt ?? now, // terminal report without a claim still gets a start time
    finishedAt: TERMINAL.has(body.status) ? now : run.finishedAt,
  }).where(eq(ciRuns.id, runId));

  if (run.changeId && TERMINAL.has(body.status)) {
    await recomputeChangeCiStatus(db, run.changeId);
  }

  // A standing-agent run terminating updates its agent: reset to idle on success,
  // else feed the failure counter (exponential backoff → circuit-breaker auto-
  // pause). `status` is the run lifecycle; "paused" is derived from `enabled`.
  if (run.standingAgentId && TERMINAL.has(body.status)) {
    await recordStandingRunResult(db, run.standingAgentId, body.status === "failure" ? "failure" : "success");
  }

  await events.publish({
    type: TERMINAL.has(body.status) ? "ci.completed" : "ci.running",
    repoId: run.repoId, changeId: run.changeId ?? undefined,
    payload: { runId: run.id, status: body.status },
  });
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
    .returning({ id: ciRuns.id, repoId: ciRuns.repoId, changeId: ciRuns.changeId, standingAgentId: ciRuns.standingAgentId });

  for (const run of reaped) {
    if (run.changeId) await recomputeChangeCiStatus(db, run.changeId);
    if (run.standingAgentId) {
      await recordStandingRunResult(db, run.standingAgentId, "failure", "run reaped: no terminal report (runner died or timed out)");
    }
    await events.publish({ type: "ci.completed", repoId: run.repoId, changeId: run.changeId ?? undefined, payload: { runId: run.id, status: "failure", reaped: true } });
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
