import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { importJobs } from "../models/schema.js";
import { log } from "./logger.js";

export type ImportProvider = "github" | "gitlab" | "bitbucket";
export type ImportJobStatus = "pending" | "running" | "success" | "failure";

export type ImportJob = typeof importJobs.$inferSelect;

/** Create a pending import job. The route returns its id; the work runs in the background. */
export async function createImportJob(
  db: DB,
  input: { agentId: string; provider: ImportProvider; source: string; targetNamespace?: string | null },
): Promise<ImportJob> {
  const [job] = await db.insert(importJobs).values({
    agentId: input.agentId,
    provider: input.provider,
    source: input.source,
    targetNamespace: input.targetNamespace ?? null,
    status: "pending",
  }).returning();
  return job;
}

export async function getImportJob(db: DB, id: string): Promise<ImportJob | null> {
  return (await db.select().from(importJobs).where(eq(importJobs.id, id)).limit(1))[0] ?? null;
}

/**
 * Run an import in the background, driving the job pending → running →
 * success|failure. `runner` does the actual clone + issue import and returns the
 * ImportResult. Always reaches a terminal state (even on throw), so a poller
 * never hangs. Fire-and-forget: callers `void runImportJob(...)` after responding.
 */
export async function runImportJob<T extends { repoId: string }>(db: DB, jobId: string, runner: () => Promise<T>): Promise<void> {
  await db.update(importJobs).set({ status: "running", startedAt: new Date() }).where(eq(importJobs.id, jobId));
  try {
    const result = await runner();
    await db.update(importJobs).set({
      status: "success",
      result: result as unknown,
      repoId: result.repoId,
      finishedAt: new Date(),
    }).where(eq(importJobs.id, jobId));
  } catch (e) {
    log("warn", "import_job_failed", { jobId, err: (e as Error).message });
    await db.update(importJobs).set({
      status: "failure",
      errorMessage: (e as Error).message,
      finishedAt: new Date(),
    }).where(eq(importJobs.id, jobId));
  }
}
