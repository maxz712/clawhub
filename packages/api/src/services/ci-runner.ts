import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciPipelines, ciRuns, repositories } from "../models/schema.js";
import { recordStandingRunResult } from "./standing-agents.js";
import { captureCiFailure } from "./memory-capture.js";
import { namespaceNameOf } from "./namespace.js";
import { parsePipelineTrigger } from "./ci-yaml.js";
import { resolveCiExecution } from "./ci-host-exec.js";
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

  // Memory capture: a FAILED CI run becomes a fingerprinted repo episode (first
  // failing step) so repeat failures cluster for consolidation and an agent
  // hitting the same red can fingerprint-retrieve the prior occurrence. Standing-
  // agent runs are excluded — their outcome episode is the harness's remember().
  if (body.status === "failure" && !run.standingAgentId) {
    const failedChange = run.changeId
      ? (await db.select().from(changes).where(eq(changes.id, run.changeId)).limit(1))[0] ?? null
      : null;
    await captureCiFailure(db, {
      runId: run.id, repoId: run.repoId, commit: run.commit,
      change: failedChange, stepResults: body.stepResults ?? (run.stepResults as unknown[] | null),
    });
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
    // Re-resolve capability-graded execution + arch pin the SAME way the enqueue
    // sites do (changes.ts:498) — the original stamp isn't persisted on the run, so
    // a re-dispatched merge->deploy would otherwise lose `execution: deploy`, fall
    // through to the sandbox branch, and run self-deploy.sh contained (no host) =>
    // a silent stranded deploy. Also carry runsOn so an arch pin survives re-dispatch.
    const trigger = parsePipelineTrigger(pipe.yaml);
    const execution = resolveCiExecution(trigger.config.execution, ns, repo.name, repo.id);
    await events.publish({
      type: "ci.run.queued", repoId: next.repoId, changeId: next.changeId ?? undefined,
      actorKind: "system", actorId: "concurrency",
      payload: {
        runId: next.id, repoNs: ns, repoName: repo.name, commit: next.commit,
        pipelineYaml: pipe.yaml, runnerToken: next.runnerToken, execution,
        ...(trigger.config.runsOn ? { runsOn: trigger.config.runsOn } : {}),
      },
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

/**
 * Pure vote: given the CI runs pinned to a change's current head, decide the
 * change-level ciStatus. Newest run per pipeline (standing / pipeline-less runs
 * never vote), tie-broken TERMINAL-FIRST then by finishedAt/createdAt so a later
 * pending/skipped duplicate can't drop an earlier genuine pass/fail. A failure is
 * decisive; otherwise the change is in flight until every pipeline's newest head-
 * run is terminal-good. Returns null when NO pipeline-bearing run exists on the
 * head (the caller decides pending-vs-skipped). Exported for unit tests.
 */
export function ciStatusFromHeadRuns(
  runs: { pipelineId: string | null; status: string; finishedAt: Date | null; createdAt: Date }[],
): "pending" | "running" | "success" | "failure" | "skipped" | null {
  const tkey = (r: { finishedAt: Date | null; createdAt: Date }) => (r.finishedAt ?? r.createdAt).getTime();
  const newest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    if (!r.pipelineId) continue;
    const prev = newest.get(r.pipelineId);
    if (!prev) { newest.set(r.pipelineId, r); continue; }
    const rt = TERMINAL.has(r.status), pt = TERMINAL.has(prev.status);
    if (rt !== pt ? rt : tkey(r) > tkey(prev)) newest.set(r.pipelineId, r);
  }
  const picked = [...newest.values()];
  if (!picked.length) return null;
  if (picked.some(r => r.status === "failure")) return "failure";
  if (picked.some(r => r.status === "running")) return "running";
  if (picked.some(r => r.status === "pending")) return "pending";
  return "success"; // all success or skipped
}

export async function recomputeChangeCiStatus(db: DB, changeId: string): Promise<void> {
  // Vote ONLY with runs pinned to the change's CURRENT head. A run on a superseded
  // head — or an orphaned/duplicate run left "running"/"failure" by a bounced
  // runner — must never decide the gate for the code being merged NOW. This both
  // (a) stops a past failure from permanently blocking a change whose current head
  // passes, and (b) is safe to call LAZILY from the merge gate so an already-
  // poisoned change self-heals on the next read with no backfill migration.
  const chg = (await db.select({ head: changes.headCommit, repoId: changes.repoId, status: changes.status })
    .from(changes).where(eq(changes.id, changeId)).limit(1))[0];
  if (!chg) return;
  if (chg.status === "merged" || chg.status === "rolled_back") return; // never mutate a terminal change
  // Exact full-SHA match — headCommit and ci_runs.commit are both the full sha
  // (post-push r.newSha); no trim/short-sha compare, or zero runs would match.
  const all = await db.select().from(ciRuns)
    .where(and(eq(ciRuns.changeId, changeId), eq(ciRuns.commit, chg.head)));
  const status = ciStatusFromHeadRuns(all);
  if (status === null) {
    // No pipeline-bearing run on the CURRENT head. Distinguish (never preserving a
    // stale value): the repo HAS push pipelines but none has reported on this head
    // yet → the gate must read 'pending' (block), never a stale terminal from a
    // prior head (post-push resets to 'pending' on push; this backstops it). The
    // repo with NO push pipeline had post-push set 'skipped'; leave it.
    const hasPush = (await db.select({ id: ciPipelines.id }).from(ciPipelines)
      .where(and(eq(ciPipelines.repoId, chg.repoId), eq(ciPipelines.enabled, true), eq(ciPipelines.triggerKind, "push"))).limit(1)).length > 0;
    if (hasPush) {
      await db.update(changes).set({ ciStatus: "pending" })
        .where(and(eq(changes.id, changeId), notInArray(changes.status, ["merged", "rolled_back"])));
    }
    return;
  }
  // Never let a late CI completion mutate a change that has already merged or
  // rolled back (scoped above + here), keeping a merged change's recorded status honest.
  await db.update(changes).set({ ciStatus: status })
    .where(and(eq(changes.id, changeId), notInArray(changes.status, ["merged", "rolled_back"])));
}
