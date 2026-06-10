import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns } from "../models/schema.js";
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

  await events.publish({
    type: TERMINAL.has(body.status) ? "ci.completed" : "ci.running",
    repoId: run.repoId, changeId: run.changeId ?? undefined,
    payload: { runId: run.id, status: body.status },
  });
}

export async function recomputeChangeCiStatus(db: DB, changeId: string): Promise<void> {
  const runs = await db.select().from(ciRuns).where(eq(ciRuns.changeId, changeId));
  let status: "pending" | "running" | "success" | "failure" | "skipped" = "pending";
  if (runs.length) {
    if (runs.some(r => r.status === "failure")) status = "failure";
    else if (runs.every(r => r.status === "success" || r.status === "skipped")) status = "success";
    else if (runs.some(r => r.status === "running")) status = "running";
    else status = "pending";
  }
  await db.update(changes).set({ ciStatus: status }).where(eq(changes.id, changeId));
}
