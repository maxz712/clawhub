import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns, standingAgents, verificationRuns } from "../models/schema.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";

// A single behavior check the verifier agent ran against the running app. The
// agent reports `ok`; ClawHub computes the run's pass/fail from these (it never
// trusts a client-supplied "status"). `evidenceUrl` points at an uploaded
// screenshot/log (via the change-evidence route).
export interface VerificationCheck {
  kind: "api" | "ui" | "cli";
  name: string;
  expected?: string;
  observed?: string;
  ok: boolean;
  evidenceUrl?: string;
}

const CHECK_KINDS = new Set(["api", "ui", "cli"]);
const MAX_CHECKS = 200;
const FIELD_CAP = 2_000;

/** Coerce + validate the agent-reported checks array. Pure (no DB). */
export function normalizeChecks(raw: unknown): VerificationCheck[] {
  if (!Array.isArray(raw)) throw new ValidationError("checks must be an array");
  if (raw.length > MAX_CHECKS) throw new ValidationError(`too many checks (max ${MAX_CHECKS})`);
  return raw.map((c, i) => {
    if (!c || typeof c !== "object") throw new ValidationError(`checks[${i}] must be an object`);
    const o = c as Record<string, unknown>;
    if (typeof o.kind !== "string" || !CHECK_KINDS.has(o.kind)) throw new ValidationError(`checks[${i}].kind must be one of ${[...CHECK_KINDS].join(", ")}`);
    if (typeof o.name !== "string" || !o.name.trim()) throw new ValidationError(`checks[${i}].name is required`);
    return {
      kind: o.kind as VerificationCheck["kind"],
      name: o.name.slice(0, 300),
      expected: typeof o.expected === "string" ? o.expected.slice(0, FIELD_CAP) : undefined,
      observed: typeof o.observed === "string" ? o.observed.slice(0, FIELD_CAP) : undefined,
      ok: o.ok === true,
      evidenceUrl: typeof o.evidenceUrl === "string" ? o.evidenceUrl.slice(0, 1_000) : undefined,
    };
  });
}

/** A verification succeeds only when EVERY check passed and at least one ran. */
export function verificationStatus(checks: VerificationCheck[]): { status: "success" | "failure"; passed: number; failed: number } {
  const passed = checks.filter(c => c.ok).length;
  const failed = checks.length - passed;
  return { status: failed === 0 && passed > 0 ? "success" : "failure", passed, failed };
}

export interface RecordVerificationInput {
  repoId: string;
  changeId: string;
  /** The authenticated agent id (from the JWT) — the claimed verifier. */
  callerAgentId: string;
  /** The ci_runs id ClawHub minted for this verify tick (the trust anchor). */
  runId: string;
  checks: VerificationCheck[];
}

export interface VerificationResult {
  id: string;
  status: "success" | "failure";
  passed: number;
  failed: number;
  headCommit: string;
}

/**
 * Record a verifier agent's e2e report as a server-trusted attestation. EVERY
 * trust-bearing fact is re-derived from ClawHub's own data, never the payload:
 *
 *  1. The run must be a ClawHub-minted standing-agent run (`origin='agent'`) for
 *     THIS repo — the agent cannot fabricate a run record.
 *  2. The caller's agent identity must BE that standing agent's identity, and the
 *     standing agent must be in `verify` mode — only a deployed verifier reports.
 *  3. The change must be in this repo and at the SAME head as the run's commit
 *     (commit read from ClawHub's DB) — so the attestation is pinned to an exact
 *     head; any later push changes the head and strands this attestation.
 *  4. No self-verify: the verifier cannot be the change's author.
 *  5. The pass/fail status is computed from the checks here — a client "status"
 *     is ignored.
 *
 * Upserts on (changeId, headCommit): re-verifying the same head replaces the row.
 */
export async function recordVerification(db: DB, input: RecordVerificationInput): Promise<VerificationResult> {
  const run = (await db.select().from(ciRuns).where(eq(ciRuns.id, input.runId)).limit(1))[0];
  if (!run) throw new NotFoundError("ci run");
  if (run.origin !== "agent" || !run.standingAgentId) throw new ForbiddenError("run is not a standing-agent run", "not_agent_run");
  if (run.repoId !== input.repoId) throw new ForbiddenError("run does not belong to this repo", "run_repo_mismatch");

  const sa = (await db.select().from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
  if (!sa) throw new NotFoundError("standing agent");
  if (sa.agentId !== input.callerAgentId) throw new ForbiddenError("caller is not this run's standing agent", "agent_mismatch");
  if (sa.mode !== "verify") throw new ForbiddenError("standing agent is not in verify mode", "not_verify_mode");

  const change = (await db.select().from(changes).where(and(eq(changes.id, input.changeId), eq(changes.repoId, input.repoId))).limit(1))[0];
  if (!change) throw new NotFoundError("change");
  if (!run.commit || run.commit !== change.headCommit) throw new ForbiddenError("run commit does not match the change head", "commit_mismatch");
  if (change.openedByAgentId && change.openedByAgentId === input.callerAgentId) {
    throw new ForbiddenError("an agent cannot verify a change it opened", "self_verify_forbidden");
  }

  const { status, passed, failed } = verificationStatus(input.checks);
  const now = new Date();
  const inserted = (await db.insert(verificationRuns).values({
    repoId: input.repoId,
    changeId: input.changeId,
    ciRunId: run.id,
    standingAgentId: sa.id,
    agentId: input.callerAgentId,
    headCommit: change.headCommit,
    status,
    checks: input.checks,
    passedCount: passed,
    failedCount: failed,
    reportedAt: now,
  }).onConflictDoUpdate({
    target: [verificationRuns.changeId, verificationRuns.headCommit],
    set: { ciRunId: run.id, standingAgentId: sa.id, agentId: input.callerAgentId, status, checks: input.checks, passedCount: passed, failedCount: failed, reportedAt: now },
  }).returning())[0];

  return { id: inserted.id, status, passed, failed, headCommit: change.headCommit };
}

/**
 * Load the verified-autonomy attestation evaluateMerge should trust for a
 * change's CURRENT head, or undefined. Only a SUCCESS row for this exact head,
 * produced by a still-enabled verify-mode standing agent that is NOT the change's
 * author, counts. The head match is the staleness guard: a new push moves the
 * head and this query stops matching the prior attestation.
 */
export async function loadVerifiedAttestation(
  db: DB,
  changeId: string,
  headCommit: string,
  openedByAgentId: string | null,
): Promise<{ ok: boolean; agentId: string; headCommit: string } | undefined> {
  const row = (await db.select({ agentId: verificationRuns.agentId, headCommit: verificationRuns.headCommit })
    .from(verificationRuns)
    .innerJoin(standingAgents, eq(verificationRuns.standingAgentId, standingAgents.id))
    .where(and(
      eq(verificationRuns.changeId, changeId),
      eq(verificationRuns.headCommit, headCommit),
      eq(verificationRuns.status, "success"),
      eq(standingAgents.enabled, true),
    ))
    .limit(1))[0];
  if (!row) return undefined;
  // Defense in depth — recordVerification already blocks self-verify.
  if (openedByAgentId && row.agentId === openedByAgentId) return undefined;
  return { ok: true, agentId: row.agentId, headCommit: row.headCommit };
}
