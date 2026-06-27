import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForReview } from "../services/repo-access.js";
import { ForbiddenError, ValidationError } from "../services/errors.js";
import { normalizeChecks, recordVerification } from "../services/verification.js";
import { enforceRate } from "../services/agent-scope.js";

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
    const body = await c.req.json().catch(() => ({})) as { runId?: string; checks?: unknown };
    if (!body.runId || typeof body.runId !== "string") throw new ValidationError("runId is required");
    const checks = normalizeChecks(body.checks ?? []);
    await enforceRate(db, p.agentId, "review");
    const result = await recordVerification(db, {
      repoId: repo.id,
      changeId: c.req.param("id"),
      callerAgentId: p.agentId,
      runId: body.runId,
      checks,
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

  return app;
}
