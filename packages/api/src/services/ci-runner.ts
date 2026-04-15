import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns } from "../models/schema.js";
import type { EventBus } from "./events.js";
import { NotFoundError, AuthError, ValidationError } from "./errors.js";

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

  const now = new Date();
  await db.update(ciRuns).set({
    status: body.status,
    logUrl: body.logUrl ?? run.logUrl,
    stepResults: body.stepResults ?? run.stepResults,
    startedAt: run.startedAt ?? (body.status === "running" ? now : run.startedAt),
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
