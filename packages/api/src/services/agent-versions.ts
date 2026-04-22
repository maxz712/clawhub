import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentVersions, evalRuns, evalSuites, type AgentVersion, type EvalRun, type EvalSuite } from "../models/schema.js";

export async function registerVersion(db: DB, input: {
  agentId: string;
  version: string;
  modelName?: string;
  promptHash?: string;
  notes?: string;
  trustTier?: "untrusted" | "sandbox" | "standard" | "trusted";
}): Promise<AgentVersion> {
  const [row] = await db.insert(agentVersions).values({
    agentId: input.agentId,
    version: input.version,
    modelName: input.modelName ?? null,
    promptHash: input.promptHash ?? null,
    notes: input.notes ?? null,
    trustTier: input.trustTier ?? "untrusted",
  }).onConflictDoUpdate({
    target: [agentVersions.agentId, agentVersions.version],
    set: { modelName: input.modelName ?? null, promptHash: input.promptHash ?? null, notes: input.notes ?? null, trustTier: input.trustTier ?? "untrusted" },
  }).returning();
  return row;
}

export async function promoteTier(db: DB, id: string, trustTier: "untrusted" | "sandbox" | "standard" | "trusted"): Promise<AgentVersion> {
  const [row] = await db.update(agentVersions).set({ trustTier }).where(eq(agentVersions.id, id)).returning();
  return row;
}

export async function listVersions(db: DB, agentId: string): Promise<AgentVersion[]> {
  return db.select().from(agentVersions).where(eq(agentVersions.agentId, agentId)).orderBy(desc(agentVersions.createdAt));
}

// --- Eval suites ---
export interface EvalCase { name: string; input: Record<string, unknown>; expected: Record<string, unknown>; weight?: number }

export async function createSuite(db: DB, input: { name: string; description?: string; cases: EvalCase[]; passingThreshold?: number }): Promise<EvalSuite> {
  const [row] = await db.insert(evalSuites).values({
    name: input.name,
    description: input.description ?? null,
    cases: input.cases,
    passingThreshold: input.passingThreshold ?? 80,
  }).returning();
  return row;
}

export async function queueEvalRun(db: DB, suiteId: string, agentId: string, agentVersionId?: string): Promise<EvalRun> {
  const [row] = await db.insert(evalRuns).values({ suiteId, agentId, agentVersionId: agentVersionId ?? null, status: "queued" }).returning();
  return row;
}

export async function startEvalRun(db: DB, id: string): Promise<void> {
  await db.update(evalRuns).set({ status: "running", startedAt: new Date() }).where(eq(evalRuns.id, id));
}

export interface EvalCaseResult { name: string; passed: boolean; score: number; notes?: string; actual?: Record<string, unknown> }

export async function finishEvalRun(db: DB, id: string, results: EvalCaseResult[]): Promise<{ run: EvalRun; promotedTo?: string }> {
  const totalWeight = results.length || 1;
  const score = Math.round((results.filter(r => r.passed).length / totalWeight) * 100);
  const [row] = await db.update(evalRuns).set({
    status: "finished",
    score,
    results: results as unknown as Record<string, unknown>[],
    finishedAt: new Date(),
  }).where(eq(evalRuns.id, id)).returning();

  // Auto-promotion: if score >= suite passing threshold, bump version trust tier one step up.
  const suite = (await db.select().from(evalSuites).where(eq(evalSuites.id, row.suiteId)).limit(1))[0];
  let promotedTo: string | undefined;
  if (suite && score >= suite.passingThreshold && row.agentVersionId) {
    const v = (await db.select().from(agentVersions).where(eq(agentVersions.id, row.agentVersionId)).limit(1))[0];
    if (v) {
      const next: Record<string, string> = { untrusted: "sandbox", sandbox: "standard", standard: "trusted", trusted: "trusted" };
      const newTier = next[v.trustTier] ?? v.trustTier;
      if (newTier !== v.trustTier) {
        await db.update(agentVersions).set({ trustTier: newTier }).where(eq(agentVersions.id, v.id));
        promotedTo = newTier;
      }
    }
  }

  return { run: row, promotedTo };
}

export async function listSuites(db: DB): Promise<EvalSuite[]> {
  return db.select().from(evalSuites).orderBy(desc(evalSuites.createdAt));
}

export async function listRunsForAgent(db: DB, agentId: string, limit = 50): Promise<EvalRun[]> {
  return db.select().from(evalRuns).where(eq(evalRuns.agentId, agentId)).orderBy(desc(evalRuns.createdAt)).limit(limit);
}

// Simple built-in runner: executes each case against a user-supplied fn.
// In production, the runner lives out-of-process; this is the reference path.
export async function runSuiteInProcess(
  db: DB,
  runId: string,
  executor: (c: EvalCase) => Promise<EvalCaseResult>,
): Promise<{ run: EvalRun; promotedTo?: string }> {
  const run = (await db.select().from(evalRuns).where(eq(evalRuns.id, runId)).limit(1))[0];
  if (!run) throw new Error("eval run not found");
  const suite = (await db.select().from(evalSuites).where(eq(evalSuites.id, run.suiteId)).limit(1))[0];
  if (!suite) throw new Error("eval suite gone");

  await startEvalRun(db, runId);
  const results: EvalCaseResult[] = [];
  for (const c of suite.cases as EvalCase[]) {
    try { results.push(await executor(c)); }
    catch (e) { results.push({ name: c.name, passed: false, score: 0, notes: String((e as Error).message ?? e) }); }
  }
  return finishEvalRun(db, runId, results);
}
