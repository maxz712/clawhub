import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns, standingAgents, verificationRuns } from "../models/schema.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { resolveSpec, type SpecBasis } from "./spec-resolver.js";
import { metrics } from "./metrics.js";

// A single behavior check the verifier agent ran against the running app. The
// agent reports `ok`; ClawHub computes the run's pass/fail from these (it never
// trusts a client-supplied "status"). `evidenceUrl` points at an uploaded
// screenshot/log (via the change-evidence route).
export interface VerificationCheck {
  // Claims taxonomy (M5 → completed N5): each kind has a server-validated evidence
  // requirement. ui = head-pinned screenshot; api = transcript (strict); cli/script =
  // command + exit 0 + transcript (strict); config = command + exit 0 + transcript
  // (always — no legacy image ever emitted config claims, so no skew window);
  // migration = the config bar AND a services/dind tier (the pooled per-run DB is
  // what makes "the migration actually ran" checkable).
  kind: "api" | "ui" | "cli" | "script" | "config" | "migration";
  name: string;
  expected?: string;
  observed?: string;
  ok: boolean;
  // cli/script claims carry the command + its exit code; under CLAWHUB_STRICT_CLAIMS
  // a cli/script check needs command + exitCode 0 + a transcript (observed) to count.
  command?: string;
  exitCode?: number;
  evidenceUrl?: string;
}

const CHECK_KINDS = new Set(["api", "ui", "cli", "script", "config", "migration"]);
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
      command: typeof o.command === "string" ? o.command.slice(0, FIELD_CAP) : undefined,
      exitCode: typeof o.exitCode === "number" ? o.exitCode : undefined,
      evidenceUrl: typeof o.evidenceUrl === "string" ? o.evidenceUrl.slice(0, 1_000) : undefined,
    };
  });
}

/** Divergence the verifier reports (undeclared behavior it found in the diff). */
export interface Divergence { undeclared: Array<{ path?: string; description: string }> }
export function normalizeDivergence(raw: unknown): Divergence {
  const list = (raw as { undeclared?: unknown } | null)?.undeclared;
  if (!Array.isArray(list)) return { undeclared: [] };
  const undeclared = list.slice(0, 50).map(item => {
    const o = (item ?? {}) as Record<string, unknown>;
    return {
      path: typeof o.path === "string" ? o.path.slice(0, 300) : undefined,
      description: (typeof o.description === "string" ? o.description : "").slice(0, FIELD_CAP),
    };
  }).filter(d => d.description);
  return { undeclared };
}

/** A verification succeeds only when EVERY check passed and at least one ran. */
export function verificationStatus(checks: VerificationCheck[]): { status: "success" | "failure"; passed: number; failed: number } {
  const passed = checks.filter(c => c.ok).length;
  const failed = checks.length - passed;
  return { status: failed === 0 && passed > 0 ? "success" : "failure", passed, failed };
}

const BEHAVIORAL_TIERS = new Set(["app", "services", "dind"]);
const evidencePathFor = (changeId: string) => `/changes/${changeId}/evidence/`;

/**
 * Tier-vs-coverage guard (the adversarial-review must-fix): an attestation only
 * counts for the check KINDS it could actually have OBSERVED at its tier, and a
 * `ui` claim must be backed by an uploaded head-pinned screenshot. So a lazy
 * `static`-tier run that *claims* "UI verified" produces an attestation with no
 * accepted behavioral coverage → status `failure` → never auto-merges.
 *
 *   accepted = intersection(claimed-passing, observable-at-this-tier)
 *   • cli            — always observable
 *   • api            — observable only when an app ran (tier app/services/dind)
 *   • ui             — observable only when an app ran AND a screenshot for THIS
 *                      change was uploaded (evidence URL on this change's path)
 *   status = success iff no check FAILED, ≥1 accepted-passing check, AND (for a
 *   behavioral tier) at least one accepted api/ui check — real exercise of the app.
 * A null tier (a Change pushed before tiering shipped) is treated as behavioral.
 */
export function evaluateCoverage(
  checks: VerificationCheck[],
  tier: string | null | undefined,
  changeId: string,
  evidenceUrls: string[],
): { status: "success" | "failure"; passed: number; failed: number; observedCoverage: string[] } {
  const onPath = evidencePathFor(changeId);
  const hasShot = evidenceUrls.some(u => typeof u === "string" && u.includes(onPath));
  const behavioral = !tier || BEHAVIORAL_TIERS.has(tier);
  // Version-skew guard (M5): the tightened cli/script/api transcript requirement
  // only applies once the rebuilt harness image actually emits transcripts. Until
  // CLAWHUB_STRICT_CLAIMS is flipped, cli/script stay always-observable + api stays
  // observable-when-behavioral (the pre-M5 contract) — so a rollout can't strand
  // in-flight runs from the old image.
  const strict = process.env.CLAWHUB_STRICT_CLAIMS === "1";
  const hasTranscript = (c: VerificationCheck) => typeof c.observed === "string" && c.observed.trim().length > 0;
  const ranWithEvidence = (c: VerificationCheck) => typeof c.command === "string" && !!c.command.trim() && c.exitCode === 0 && hasTranscript(c);
  const observable = (c: VerificationCheck): boolean => {
    // N5: the reserved kinds are now validatable. Both demand hard run evidence
    // from day one (command + exit 0 + transcript — these kinds never existed
    // pre-strict, so there is no old-image skew window to accommodate).
    // `migration` additionally needs a tier whose pooled per-run DB could actually
    // execute it (services/dind) — a static/app run has nothing to migrate against.
    if (c.kind === "config") return ranWithEvidence(c);
    if (c.kind === "migration") return (tier === "services" || tier === "dind") && ranWithEvidence(c);
    if (c.kind === "cli" || c.kind === "script") {
      if (!strict) return true;
      return typeof c.command === "string" && !!c.command.trim() && c.exitCode === 0 && hasTranscript(c);
    }
    if (!behavioral) return false;                          // api/ui can't be observed at static
    if (c.kind === "api") return strict ? hasTranscript(c) : true; // strict: needs a request/response transcript
    /* ui */ return hasShot || (typeof c.evidenceUrl === "string" && c.evidenceUrl.includes(onPath));
  };
  const anyFailed = checks.some(c => !c.ok);
  const acceptedPassed = checks.filter(c => c.ok && observable(c));
  const observedCoverage = [...new Set(acceptedPassed.map(c => c.kind))];
  // Behavioral coverage = at least one accepted api/ui check (a real exercise of the
  // running app). cli/script alone is corroboration, not app-behavior evidence.
  const coverageOk = behavioral ? acceptedPassed.some(c => c.kind === "api" || c.kind === "ui") : acceptedPassed.length > 0;
  const status: "success" | "failure" = !anyFailed && acceptedPassed.length > 0 && coverageOk ? "success" : "failure";
  return { status, passed: acceptedPassed.length, failed: checks.filter(c => !c.ok).length, observedCoverage };
}

export interface RecordVerificationInput {
  repoId: string;
  changeId: string;
  /** The authenticated agent id (from the JWT) — the claimed verifier. */
  callerAgentId: string;
  /** The ci_runs id ClawHub minted for this verify tick (the trust anchor). */
  runId: string;
  checks: VerificationCheck[];
  /** URLs of screenshots/logs the verifier uploaded for THIS change (evidence for
   *  the tier-vs-coverage guard — a `ui` claim needs one). Server-validated to point
   *  at this change's evidence path. */
  evidence?: string[];
  /** Undeclared behavior the verifier found (description↔diff divergence). Normalized. */
  divergence?: unknown;
}

export interface VerificationResult {
  id: string;
  status: "success" | "failure";
  passed: number;
  failed: number;
  headCommit: string;
  specBasis: SpecBasis;
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

  // Tier-vs-coverage guard: the tier is the SERVER's (change.verifyTier), never the
  // agent's claim. Accepted coverage = intersection(claimed, observable-at-tier); a
  // `ui` claim needs an uploaded screenshot for this change. A lazy run can't pass.
  const tier = change.verifyTier ?? null;
  const { status, passed, failed, observedCoverage } = evaluateCoverage(input.checks, tier, input.changeId, input.evidence ?? []);
  // Resolve the behavior-spec basis SERVER-SIDE at record time — authoritative,
  // never the payload. Stamped so the merge gate can read it (inferred basis
  // satisfies verified autonomy only at low risk). Divergence is normalized.
  const resolved = await resolveSpec(db, change);
  const divergence = normalizeDivergence(input.divergence);
  const now = new Date();
  const inserted = (await db.insert(verificationRuns).values({
    repoId: input.repoId,
    changeId: input.changeId,
    ciRunId: run.id,
    standingAgentId: sa.id,
    agentId: input.callerAgentId,
    headCommit: change.headCommit,
    status,
    tier,
    observedCoverage,
    checks: input.checks,
    specBasis: resolved.basis,
    specExcerpt: resolved.excerpt || null,
    divergence,
    passedCount: passed,
    failedCount: failed,
    reportedAt: now,
  }).onConflictDoUpdate({
    target: [verificationRuns.changeId, verificationRuns.headCommit],
    set: { ciRunId: run.id, standingAgentId: sa.id, agentId: input.callerAgentId, status, tier, observedCoverage, checks: input.checks, specBasis: resolved.basis, specExcerpt: resolved.excerpt || null, divergence, passedCount: passed, failedCount: failed, reportedAt: now },
  }).returning())[0];

  // Verify funnel tripwire (M8): attested is the terminal stage of the verify
  // funnel (dispatched → booted → attested). Split by success/failure + basis.
  metrics.inc("clawhub_verify_funnel_total", { stage: "attested", status, basis: resolved.basis });
  return { id: inserted.id, status, passed, failed, headCommit: change.headCommit, specBasis: resolved.basis };
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
): Promise<{ ok: boolean; agentId: string; headCommit: string; tier: string | null; specBasis: SpecBasis } | undefined> {
  const row = (await db.select({ agentId: verificationRuns.agentId, headCommit: verificationRuns.headCommit, tier: verificationRuns.tier, specBasis: verificationRuns.specBasis })
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
  // Null/legacy basis = inferred (conservative — the gate then caps it at low risk).
  return { ok: true, agentId: row.agentId, headCommit: row.headCommit, tier: row.tier ?? null, specBasis: (row.specBasis as SpecBasis | null) ?? "inferred" };
}

/**
 * Whether a head-pinned verification row still COUNTS toward the verified-autonomy
 * gate, mirroring `loadVerifiedAttestation`'s trust preconditions EXACTLY so the
 * dashboard never shows a green "attested" for a signal the gate already dropped
 * (#78). A success row counts only when its verify-mode agent still exists + is
 * enabled (`verifierEnabled === true`) and is not the change's author. A deleted
 * agent row nulls `standingAgentId` (SET NULL) → callers pass `verifierEnabled`
 * as null/undefined → does NOT count. Non-success rows never "count" and carry no
 * stale reason (failure/pending are shown as-is, not as a dropped attestation).
 */
export function verificationTrust(
  row: { status: string; agentId: string | null },
  verifierEnabled: boolean | null | undefined,
  openedByAgentId: string | null,
): { counts: boolean; staleReason: "verifier_disabled" | "self_verify" | null } {
  const selfVerify = row.agentId != null && row.agentId === openedByAgentId;
  const verifierGone = verifierEnabled !== true;
  const counts = row.status === "success" && !verifierGone && !selfVerify;
  const staleReason = row.status === "success" && !counts
    ? (selfVerify ? "self_verify" : "verifier_disabled")
    : null;
  return { counts, staleReason };
}
