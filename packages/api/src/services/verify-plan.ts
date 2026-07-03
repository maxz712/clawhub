import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, ciRuns, standingAgents, verifyPlans } from "../models/schema.js";
import type { VerifyPlan } from "../models/schema.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
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
  const checkMap = (input.checkMap && typeof input.checkMap === "object") ? input.checkMap : {};

  // At most one active plan per change: deactivate the old, insert the new.
  await db.update(verifyPlans).set({ active: false, updatedAt: new Date() }).where(and(eq(verifyPlans.changeId, input.changeId), eq(verifyPlans.active, true)));
  const [row] = await db.insert(verifyPlans).values({
    repoId: input.repoId, changeId: input.changeId,
    standingAgentId: sa.id, agentId: input.callerAgentId,
    steps: validation.steps, checkMap,
    changedPathsHash: hashPaths(changedPaths), specHash: hashSpec(spec.spec), tier: change.verifyTier ?? null,
    active: true,
  }).returning();
  return { id: row.id };
}

/** Load the active plan for a change (for the runner's playback decision). */
export async function loadActiveVerifyPlan(db: DB, changeId: string): Promise<VerifyPlan | null> {
  return (await db.select().from(verifyPlans).where(and(eq(verifyPlans.changeId, changeId), eq(verifyPlans.active, true))).limit(1))[0] ?? null;
}

/** Compute the CURRENT staleness anchors for a change (to compare against a plan). */
export async function currentPlanAnchors(db: DB, change: Pick<typeof changes.$inferSelect, "id" | "intent" | "description" | "branch" | "changedPaths" | "verifyTier">): Promise<{ changedPathsHash: string; specHash: string; tier: string | null }> {
  const changedPaths = Array.isArray(change.changedPaths) ? (change.changedPaths as unknown[]).filter((p): p is string => typeof p === "string") : [];
  const spec = await resolveSpec(db, change);
  return { changedPathsHash: hashPaths(changedPaths), specHash: hashSpec(spec.spec), tier: change.verifyTier ?? null };
}
