import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns, standingAgents, verifyPlans } from "../models/schema.js";
import type { VerifyPlan } from "../models/schema.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { resolveSpec } from "./spec-resolver.js";

// Plan-then-playback cheap verify (M6). A verify run authors a PLAN — a scripted
// browse sequence + a steps→checks map. A later verify run on the SAME change with
// unchanged paths/spec/tier REPLAYS the plan with ZERO model tokens and attests
// from the deterministic browse result. The steps are SERVER-VALIDATED so a plan
// can't smuggle in an attack: only whitelisted step types, and every navigation
// target (goto/apiCheck) must be relative or localhost — the sandboxed app under
// test, never an arbitrary host.

export const VERIFY_STEP_TYPES = new Set([
  "goto", "click", "fill", "snapshot", "screenshot",
  "expectVisible", "expectUrl", "expectValue", "expectCount", "expectStyle", "apiCheck",
]);
const MAX_STEPS = 200;

/** A navigation target is safe iff it's a relative path or points at localhost. */
export function isLocalTarget(target: unknown): boolean {
  if (typeof target !== "string" || !target) return false;
  if (target.startsWith("/") && !target.startsWith("//")) return true; // relative path
  try {
    const u = new URL(target);
    return (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "0.0.0.0")
      && (u.protocol === "http:" || u.protocol === "https:");
  } catch { return false; }
}

export interface VerifyStep { type: string; [k: string]: unknown }

/** Validate + normalize a plan's steps. Pure. Rejects (never sanitizes away) a bad step. */
export function validateVerifyPlan(rawSteps: unknown): { ok: true; steps: VerifyStep[] } | { ok: false; error: string } {
  if (!Array.isArray(rawSteps)) return { ok: false, error: "steps must be an array" };
  if (rawSteps.length === 0) return { ok: false, error: "a plan needs at least one step" };
  if (rawSteps.length > MAX_STEPS) return { ok: false, error: `too many steps (max ${MAX_STEPS})` };
  const steps: VerifyStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const s = rawSteps[i];
    if (!s || typeof s !== "object") return { ok: false, error: `steps[${i}] must be an object` };
    const o = s as Record<string, unknown>;
    if (typeof o.type !== "string" || !VERIFY_STEP_TYPES.has(o.type)) return { ok: false, error: `steps[${i}].type must be one of ${[...VERIFY_STEP_TYPES].join(", ")}` };
    if (o.type === "goto" && !isLocalTarget(o.url ?? o.target)) return { ok: false, error: `steps[${i}] goto must target a relative path or localhost` };
    if (o.type === "apiCheck" && !isLocalTarget(o.url ?? o.target)) return { ok: false, error: `steps[${i}] apiCheck must target a relative path or localhost` };
    steps.push(o as VerifyStep);
  }
  return { ok: true, steps };
}

// The playback harness maps checkMap[stepIndex] → an attestation check VERBATIM
// (kind + name), so an unvalidated map could dress a trivial step up as a strong
// claim — e.g. a `snapshot` step attested as an `api` check the coverage gate
// credits. Constrain it server-side: keys must be step indices, `kind` only
// ui|api, and `api` only when the mapped step is a real apiCheck. cli/script
// kinds can never come from playback (no commands run during a browse replay).
const CHECKMAP_KINDS = new Set(["ui", "api"]);
const MAX_CHECK_NAME = 200;

export function validateCheckMap(raw: unknown, steps: VerifyStep[]): { ok: true; checkMap: Record<string, { kind: string; name: string }> } | { ok: false; error: string } {
  if (raw == null) return { ok: true, checkMap: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "checkMap must be an object keyed by step index" };
  const out: Record<string, { kind: string; name: string }> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) return { ok: false, error: `checkMap key "${key}" is not a valid step index` };
    if (!val || typeof val !== "object") return { ok: false, error: `checkMap["${key}"] must be an object` };
    const v = val as Record<string, unknown>;
    const kind = typeof v.kind === "string" ? v.kind : "ui";
    if (!CHECKMAP_KINDS.has(kind)) return { ok: false, error: `checkMap["${key}"].kind must be one of ${[...CHECKMAP_KINDS].join(", ")}` };
    if (kind === "api" && steps[idx].type !== "apiCheck") return { ok: false, error: `checkMap["${key}"] claims kind "api" but steps[${idx}] is "${steps[idx].type}" — an api check must map an apiCheck step` };
    const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, MAX_CHECK_NAME) : `step ${key}`;
    out[key] = { kind, name };
  }
  return { ok: true, checkMap: out };
}

export function hashPaths(paths: string[]): string {
  return createHash("sha256").update([...paths].sort().join("\n")).digest("hex");
}
export function hashSpec(spec: string): string {
  return createHash("sha256").update(spec ?? "").digest("hex");
}

/** True when a plan is STALE for the current change state → playback must fall
 *  through to a full model verify. Paths/spec/tier drift, or 2+ playback failures. */
export function isPlanStale(plan: Pick<VerifyPlan, "changedPathsHash" | "specHash" | "tier" | "failureCount">, cur: { changedPathsHash: string; specHash: string; tier: string | null }): boolean {
  if (plan.failureCount >= 2) return true;
  if (plan.changedPathsHash !== cur.changedPathsHash) return true;
  if (plan.specHash !== cur.specHash) return true;
  if ((plan.tier ?? null) !== (cur.tier ?? null)) return true;
  return false;
}

export interface PutVerifyPlanInput {
  repoId: string;
  changeId: string;
  callerAgentId: string;
  runId: string;
  steps: unknown;
  checkMap: unknown;
}

/**
 * Author (or replace) the active plan for a change. Re-binds the caller EXACTLY
 * like recordVerification — the run must be a ClawHub-minted verify run for this
 * repo, the caller must BE that run's verify-mode standing agent, the change head
 * must match the run's commit, and the author cannot be the change's author. The
 * plan's staleness anchors (paths/spec/tier) are computed SERVER-SIDE.
 */
export async function putVerifyPlan(db: DB, input: PutVerifyPlanInput): Promise<{ id: string }> {
  const validation = validateVerifyPlan(input.steps);
  if (!validation.ok) throw new ValidationError(validation.error);

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
  if (change.openedByAgentId && change.openedByAgentId === input.callerAgentId) throw new ForbiddenError("an agent cannot author a verify plan for a change it opened", "self_verify_forbidden");

  const changedPaths = Array.isArray(change.changedPaths) ? (change.changedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const spec = await resolveSpec(db, change);
  const mapValidation = validateCheckMap(input.checkMap, validation.steps);
  if (!mapValidation.ok) throw new ValidationError(mapValidation.error);
  const checkMap = mapValidation.checkMap;

  // At most one active plan per change (verify_plans_active_uniq): deactivate the
  // old, insert the new. The two statements are not atomic across processes, so a
  // concurrent writer can land its active row between them — the partial unique
  // index then rejects OUR insert with 23505, which used to surface as a raw 500
  // (#81). Treat it as the lost race it is: deactivate again (covering the row
  // the winner just inserted) and retry once; a second collision yields a clean
  // 409 instead of a server error.
  for (let attempt = 0; ; attempt++) {
    await db.update(verifyPlans).set({ active: false, updatedAt: new Date() }).where(and(eq(verifyPlans.changeId, input.changeId), eq(verifyPlans.active, true)));
    try {
      const [row] = await db.insert(verifyPlans).values({
        repoId: input.repoId, changeId: input.changeId,
        standingAgentId: sa.id, agentId: input.callerAgentId,
        steps: validation.steps, checkMap,
        changedPathsHash: hashPaths(changedPaths), specHash: hashSpec(spec.spec), tier: change.verifyTier ?? null,
        active: true,
      }).returning();
      return { id: row.id };
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && attempt === 0) continue;
      if ((e as { code?: string }).code === "23505") throw new ConflictError("a concurrent verify-plan write won — retry");
      throw e;
    }
  }
}

/** Load the active plan for a change (for the runner's playback decision). */
export async function loadActiveVerifyPlan(db: DB, changeId: string): Promise<VerifyPlan | null> {
  return (await db.select().from(verifyPlans).where(and(eq(verifyPlans.changeId, changeId), eq(verifyPlans.active, true))).limit(1))[0] ?? null;
}

export interface RecordPlaybackOutcomeInput {
  repoId: string;
  changeId: string;
  callerAgentId: string;
  runId: string;
  success: boolean;
}

/**
 * Record a playback attempt's outcome against the change's ACTIVE plan — the
 * only write path for `failureCount` (previously dead: nothing ever moved it
 * off its default of 0, so `isPlanStale`'s 2-consecutive-failure branch could
 * never fire). Re-binds the caller EXACTLY like putVerifyPlan (the run must be
 * a ClawHub-minted verify run for this repo, at this change's head, and the
 * caller must BE that run's verify-mode standing agent) — a playback attempt
 * always happens inside a real verify run, so this is the same trust boundary.
 * A failure increments the counter; a success resets it to 0 so staleness
 * reflects CONSECUTIVE failures, not a lifetime total. Returns null (no-op,
 * not an error) when the change has no active plan to update.
 */
export async function recordPlaybackOutcome(db: DB, input: RecordPlaybackOutcomeInput): Promise<{ failureCount: number } | null> {
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

  const plan = await loadActiveVerifyPlan(db, input.changeId);
  if (!plan || plan.repoId !== input.repoId) return null;

  const failureCount = input.success ? 0 : plan.failureCount + 1;
  await db.update(verifyPlans).set({ failureCount, updatedAt: new Date() }).where(eq(verifyPlans.id, plan.id));
  return { failureCount };
}

/** Compute the CURRENT staleness anchors for a change (to compare against a plan). */
export async function currentPlanAnchors(db: DB, change: Pick<typeof changes.$inferSelect, "id" | "intent" | "description" | "branch" | "changedPaths" | "verifyTier">): Promise<{ changedPathsHash: string; specHash: string; tier: string | null }> {
  const changedPaths = Array.isArray(change.changedPaths) ? (change.changedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const spec = await resolveSpec(db, change);
  return { changedPathsHash: hashPaths(changedPaths), specHash: hashSpec(spec.spec), tier: change.verifyTier ?? null };
}
