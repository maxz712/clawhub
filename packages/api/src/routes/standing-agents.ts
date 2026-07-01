import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repositories } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import type { NamespaceKind } from "../services/namespace.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { isSecretsKeyConfigured } from "../services/secrets.js";
import { killedAgentSet } from "../services/kill-switch.js";
import {
  createStandingAgent, deleteStandingAgent, dispatchStandingRun, getStandingAgent,
  listStandingAgents, redactStanding, updateStandingAgent,
} from "../services/standing-agents.js";

// Standing agents are configured by HUMAN operators (they bring the AI + its
// credentials). Require a user token with write to the repo — never an agent
// token, so an agent can't attach a standing worker to itself.
async function assertOperator(
  db: DB,
  payload: { kind: string; userId?: string },
  repoId: string,
  ns: { kind: NamespaceKind; id: string },
): Promise<void> {
  if (payload.kind !== "user" || !payload.userId) throw new AuthError("user token required");
  if (ns.kind === "user" && ns.id === payload.userId) return;
  if (ns.kind === "agent") {
    const a = (await db.select().from(agents).where(and(eq(agents.id, ns.id), eq(agents.associatedUserId, payload.userId))).limit(1))[0];
    if (a) return;
  }
  if (ns.kind === "org") {
    // Standing agents control credentials + grant repo writes — require org ADMIN,
    // not merely membership (a plain member must not attach a BYO agent).
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, ns.id), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (m) return;
  }
  throw new AuthError("forbidden");
}

export function createStandingAgentRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/standing-agents", async c => {
    const { repo, namespace } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertOperator(db, c.get("tokenPayload"), repo.id, namespace);
    const rows = await listStandingAgents(db, repo.id);
    const killed = await killedAgentSet(db, rows.map(r => r.agentId));
    return c.json({ standingAgents: rows.map(r => ({ ...redactStanding(r), killed: killed.has(r.agentId) })) });
  });

  app.post("/:ns/:repo/standing-agents", async c => {
    if (!isSecretsKeyConfigured()) throw new ValidationError("server missing CLAWHUB_SECRETS_KEY (cannot seal credentials)");
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    await assertOperator(db, p, repo.id, namespace);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.name || typeof body.name !== "string") throw new ValidationError("name required");
    // image is optional: omit it to run the built-in reference harness (Claude
    // Code + browser). When supplied it must be a string.
    if (body.image !== undefined && typeof body.image !== "string") throw new ValidationError("image must be a string");
    if (!body.agentToken && !body.agentName) throw new ValidationError("one of agentToken or agentName is required");
    if (p.kind !== "user") throw new AuthError("user token required"); // narrows p.userId for TS
    const row = await createStandingAgent(db, {
      repoId: repo.id,
      name: body.name,
      image: body.image as string | undefined,
      command: (body.command as string | undefined) ?? null,
      trigger: body.trigger as string | undefined,
      cron: (body.cron as string | undefined) ?? null,
      event: (body.event as string | undefined) ?? null,
      intervalSec: body.intervalSec as number | undefined,
      mode: body.mode as string | undefined,
      task: body.task as string | undefined,
      llmProvider: body.llmProvider as string | undefined,
      cli: body.cli as string | undefined,
      model: (body.model as string | null | undefined),
      llmBaseUrl: (body.llmBaseUrl as string | undefined) ?? null,
      llmApiKey: (body.llmApiKey as string | undefined) ?? null,
      memoryMb: body.memoryMb as number | undefined,
      cpus: body.cpus as number | undefined,
      timeoutSec: body.timeoutSec as number | undefined,
      egressPolicy: body.egressPolicy as string | undefined,
      egressAllowedHosts: body.egressAllowedHosts as string[] | undefined,
      agentToken: body.agentToken as string | undefined,
      agentName: body.agentName as string | undefined,
      rotateToken: body.rotateToken as boolean | undefined,
      createdByUserId: p.userId,
    });
    return c.json({ standingAgent: redactStanding(row) }, 201);
  });

  app.patch("/:ns/:repo/standing-agents/:id", async c => {
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertOperator(db, c.get("tokenPayload"), repo.id, namespace);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const row = await updateStandingAgent(db, repo.id, c.req.param("id"), {
      name: body.name as string | undefined,
      image: body.image as string | undefined,
      command: body.command as string | null | undefined,
      trigger: body.trigger as string | undefined,
      cron: body.cron as string | null | undefined,
      event: body.event as string | null | undefined,
      intervalSec: body.intervalSec as number | undefined,
      mode: body.mode as string | undefined,
      task: body.task as string | undefined,
      llmProvider: body.llmProvider as string | undefined,
      cli: body.cli as string | undefined,
      model: body.model as string | null | undefined,
      llmBaseUrl: body.llmBaseUrl as string | null | undefined,
      llmApiKey: body.llmApiKey as string | undefined,
      memoryMb: body.memoryMb as number | undefined,
      cpus: body.cpus as number | undefined,
      timeoutSec: body.timeoutSec as number | undefined,
      egressPolicy: body.egressPolicy as string | undefined,
      egressAllowedHosts: body.egressAllowedHosts as string[] | undefined,
      enabled: body.enabled as boolean | undefined,
    });
    return c.json({ standingAgent: redactStanding(row) });
  });

  app.delete("/:ns/:repo/standing-agents/:id", async c => {
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertOperator(db, c.get("tokenPayload"), repo.id, namespace);
    await deleteStandingAgent(db, repo.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  // Fire one tick now (bypasses the trigger schedule; still governance-checked).
  app.post("/:ns/:repo/standing-agents/:id/run", async c => {
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertOperator(db, c.get("tokenPayload"), repo.id, namespace);
    const sa = await getStandingAgent(db, repo.id, c.req.param("id"));
    // Per-run activation: point an idle agent at an ad-hoc `task` (a prompt) and/or a
    // specific `issue` (by number) at trigger time — not baked into the agent. Either,
    // both, or neither (neither = fall back to the agent's stored task / grabbing issues).
    const body = await c.req.json().catch(() => ({})) as { task?: unknown; issue?: unknown };
    const task = typeof body.task === "string" && body.task.trim() ? body.task.trim() : undefined;
    const issue = typeof body.issue === "number" && Number.isInteger(body.issue) ? body.issue
      : (typeof body.issue === "string" && /^\d+$/.test(body.issue.trim()) ? Number(body.issue.trim()) : undefined);
    const result = await dispatchStandingRun(db, events, sa, { manual: true, task, issue });
    if (!result.ok) return c.json({ ok: false, reason: result.reason }, 409);
    return c.json({ ok: true, runId: result.runId });
  });

  return app;
}
