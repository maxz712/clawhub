import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForReview } from "../services/repo-access.js";
import { ForbiddenError, ValidationError } from "../services/errors.js";
import { normalizeChecks, recordVerification } from "../services/verification.js";
import { putVerifyPlan, loadActiveVerifyPlan, currentPlanAnchors, isPlanStale, recordPlaybackOutcome } from "../services/verify-plan.js";
import { enforceRate } from "../services/agent-scope.js";
import { and, eq } from "drizzle-orm";
import { changes } from "../models/schema.js";
import { NotFoundError } from "../services/errors.js";

/**
 * Verification reports from deployed verify-mode reviewer agents. Mounted under
 * /api/v1/repos. Authed with the AGENT JWT (the container holds the agent token,
 * not the runner token) at REVIEW level — a reviewer-grant collaborator can post
 * without the broader write surface. Every trust-bearing fact is re-checked
 * server-side in recordVerification (the run is ClawHub-minted for this agent,
 * the commit matches the change head, no self-verify); the payload alone proves
 * nothing. A success report feeds the verified-autonomy merge gate. See
 * services/verification.ts + docs/verified-autonomy.md.
 */
export function createVerificationRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/:ns/:repo/changes/:id/verification", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new ForbiddenError("verification reports come from agents", "agent_only");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), p);
    const body = await c.req.json().catch(() => ({})) as { runId?: string; checks?: unknown; evidence?: unknown; divergence?: unknown };
    if (!body.runId || typeof body.runId !== "string") throw new ValidationError("runId is required");
    const checks = normalizeChecks(body.checks ?? []);
    // Uploaded screenshot/log URLs backing the checks (the tier-vs-coverage guard
    // validates a `ui` claim against one that points at THIS change's evidence path).
    const evidence = Array.isArray(body.evidence) ? body.evidence.filter((u): u is string => typeof u === "string").slice(0, 50) : [];
    await enforceRate(db, p.agentId, "review");
    const result = await recordVerification(db, {
      repoId: repo.id,
      changeId: c.req.param("id"),
      callerAgentId: p.agentId,
      runId: body.runId,
      checks,
      evidence,
      // Undeclared behavior the verifier found (M5) — normalized server-side.
      divergence: body.divergence,
    });
    // change.verified drives the hands-off auto-merge subscriber in app.ts.
    await events.publish({
      type: "change.verified",
      repoId: repo.id,
      changeId: c.req.param("id"),
      actorKind: "agent",
      actorId: p.agentId,
      payload: { status: result.status, passed: result.passed, failed: result.failed },
    });
    return c.json({ verification: result }, 201);
  });

  // Plan-then-playback (M6). A verify run PUTs a scripted plan (browse steps +
  // steps→checks map); server-validated + re-bound like a verification report.
  app.put("/:ns/:repo/changes/:id/verify-plan", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new ForbiddenError("verify plans come from agents", "agent_only");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), p);
    const body = await c.req.json().catch(() => ({})) as { runId?: string; steps?: unknown; checkMap?: unknown };
    if (!body.runId || typeof body.runId !== "string") throw new ValidationError("runId is required");
    await enforceRate(db, p.agentId, "review");
    const result = await putVerifyPlan(db, {
      repoId: repo.id, changeId: c.req.param("id"), callerAgentId: p.agentId,
      runId: body.runId, steps: body.steps, checkMap: body.checkMap,
    });
    return c.json({ plan: result }, 201);
  });

  // Playback outcome (M6 fix): the harness reports whether a playback attempt
  // derived usable checks BEFORE it falls through to a full model verify on
  // failure. This is the only write path for `verify_plans.failureCount` —
  // without it `isPlanStale`'s 2-consecutive-failure branch is unreachable.
  app.post("/:ns/:repo/changes/:id/verify-plan/outcome", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new ForbiddenError("verify plan outcomes come from agents", "agent_only");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), p);
    const body = await c.req.json().catch(() => ({})) as { runId?: string; success?: unknown };
    if (!body.runId || typeof body.runId !== "string") throw new ValidationError("runId is required");
    await enforceRate(db, p.agentId, "review");
    const result = await recordPlaybackOutcome(db, {
      repoId: repo.id, changeId: c.req.param("id"), callerAgentId: p.agentId,
      runId: body.runId, success: body.success === true,
    });
    return c.json({ plan: result });
  });

  // The active plan for a change + whether it's STALE for the current state — the
  // runner reads this to decide playback (fresh + same paths/spec/tier) vs a full
  // model verify (stale). Review-level auth so the verifier agent can read it.
  app.get("/:ns/:repo/changes/:id/verify-plan", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), p);
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const plan = await loadActiveVerifyPlan(db, change.id);
    if (!plan) return c.json({ plan: null, stale: true });
    const anchors = await currentPlanAnchors(db, change);
    const stale = isPlanStale(plan, anchors);
    return c.json({ plan: { id: plan.id, steps: plan.steps, checkMap: plan.checkMap, failureCount: plan.failureCount, tier: plan.tier }, stale });
  });

  return app;
}
