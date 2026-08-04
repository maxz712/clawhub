import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { agents, accessRoles, llmKeys, standingAgents } from "../models/schema.js";
import {
  createWorkflow, deleteWorkflow, deploymentFor, dispatchWorkflow, listWorkflowsFor,
  resolveWorkflowRepos, updateWorkflow, WORKFLOW_TEMPLATES, workflowActivity, workflowFor,
} from "../services/workflows.js";
import { dispatchStandingRun, redactStanding, standingAgentReachesRepoId, updateStandingAgent, validateModelForMode } from "../services/standing-agents.js";
import { isModelSelectableForKey, normalizeByoProvider } from "../services/byo-model-catalog.js";
import { unseal } from "../services/secrets.js";
import { getAuditLog } from "../services/audit.js";

/**
 * v4 workflow + deployment management (docs/redesign-v4.md). User-token only.
 *
 *   GET/POST   /api/v1/workflows            — list / create
 *   PATCH/DELETE /api/v1/workflows/:id      — edit / remove (fully editable)
 *   POST       /api/v1/workflows/:id/run    — manual dispatch (optional repoId)
 *   GET        /api/v1/workflows/:id/activity — the workflow's run history,
 *              framed as PRODUCED ACTIVITY (changes worked, reviews submitted)
 *   GET        /api/v1/workflow-templates   — deploy-ready presets (the old
 *              Templates page, folded into the Workflows tab)
 *
 * Deployment (repo-less standing agent) management rides on the same router
 * factory and mounts under /api/v1/standing-agents (see app.ts):
 *   PATCH /:id (model/cli/key edits), DELETE /:id, POST /:id/run.
 */
export function createWorkflowRoutes(db: DB, events: EventBus): { workflows: Hono; templates: Hono; deployments: Hono } {
  const wfApp = new Hono();
  const tplApp = new Hono();
  const depApp = new Hono();
  for (const a of [wfApp, tplApp, depApp]) a.use("*", authMiddleware);

  const requireUser = (c: { get: (k: "tokenPayload") => { kind: string; userId?: string } }) => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user" || !p.userId) throw new AuthError("user token required");
    return p as { kind: "user"; userId: string };
  };

  // ---- workflows -----------------------------------------------------------

  wfApp.get("/", async c => {
    const p = requireUser(c);
    return c.json({ workflows: await listWorkflowsFor(db, p.userId) });
  });

  wfApp.post("/", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const wf = await createWorkflow(db, p.userId, body as Parameters<typeof createWorkflow>[2]);
    void getAuditLog(db).record({ actorKind: "human", actorId: p.userId, action: "workflow.created", category: "ci", metadata: { workflowId: wf.id, name: wf.name, trigger: wf.trigger } });
    return c.json({ workflow: wf }, 201);
  });

  wfApp.patch("/:id", async c => {
    const p = requireUser(c);
    const body = await c.req.json().catch(() => ({}));
    const wf = await updateWorkflow(db, p.userId, c.req.param("id"), body as Parameters<typeof updateWorkflow>[3]);
    void getAuditLog(db).record({ actorKind: "human", actorId: p.userId, action: "workflow.updated", category: "ci", metadata: { workflowId: wf.id } });
    return c.json({ workflow: wf });
  });

  wfApp.delete("/:id", async c => {
    const p = requireUser(c);
    await deleteWorkflow(db, p.userId, c.req.param("id"));
    void getAuditLog(db).record({ actorKind: "human", actorId: p.userId, action: "workflow.deleted", category: "ci", metadata: { workflowId: c.req.param("id") } });
    return c.json({ ok: true });
  });

  wfApp.post("/:id/run", async c => {
    const p = requireUser(c);
    const wf = await workflowFor(db, p.userId, c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as { repoId?: string; issue?: number; focus?: string };
    // #120: a caller-named target repo is authorized against the DEPLOYMENT's
    // reach, not just against ownership of the workflow. dispatchWorkflow drops
    // an out-of-reach repo either way; this is where it becomes a visible 403.
    if (typeof body.repoId === "string" && !(await standingAgentReachesRepoId(db, wf.standingAgent, body.repoId))) {
      throw new ForbiddenError("this deployment has no access to that repo");
    }
    const results = await dispatchWorkflow(db, events, wf, {
      repoId: typeof body.repoId === "string" ? body.repoId : undefined,
      manual: true, triggeredByUserId: p.userId,
      issue: typeof body.issue === "number" ? body.issue : undefined,
      focus: typeof body.focus === "string" ? body.focus : undefined,
    });
    if (!results.length) throw new ValidationError("no repos in this workflow's reach — point its deployment's role at a repo, or pass repoId");
    return c.json({ dispatched: results.filter(r => r.result.ok).length, results: results.map(r => ({ repoId: r.repoId, ...r.result })) }, 201);
  });

  wfApp.get("/:id/activity", async c => {
    const p = requireUser(c);
    const wf = await workflowFor(db, p.userId, c.req.param("id"));
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50) || 50);
    return c.json({ workflow: { id: wf.id, name: wf.name, instructions: wf.instructions, trigger: wf.trigger }, activity: await workflowActivity(db, wf, limit) });
  });

  // ---- templates -----------------------------------------------------------

  tplApp.get("/", c => c.json({ templates: WORKFLOW_TEMPLATES }));

  // ---- deployments (repo-less standing agents) ------------------------------

  depApp.patch("/:id", async c => {
    const p = requireUser(c);
    const sa = await deploymentFor(db, p.userId, c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as {
      model?: string | null; cli?: string; execStyle?: string; enabled?: boolean;
      llmKeyId?: string; keySource?: "byo" | "platform";
      name?: string; cpus?: number; memoryMb?: number; timeoutSec?: number;
      egressPolicy?: string; mode?: string; task?: string; accessRoleId?: string;
    };
    // Key changes come from the VAULT (never a raw key over this surface).
    let llmApiKey: string | undefined;
    let llmProvider: string | undefined;
    let keyRow: typeof llmKeys.$inferSelect | undefined;
    if (body.llmKeyId) {
      keyRow = (await db.select().from(llmKeys)
        .where(and(eq(llmKeys.id, body.llmKeyId), eq(llmKeys.ownerUserId, p.userId))).limit(1))[0];
      if (!keyRow) throw new NotFoundError("llm key");
      llmApiKey = unseal(keyRow.ciphertext, keyRow.nonce);
      llmProvider = keyRow.provider === "openai" || keyRow.provider === "openrouter" ? "openai" : keyRow.provider === "google" ? "google" : "anthropic";
    }
    const effectiveKeySource = (body.keySource ?? sa.keySource) as "byo" | "platform";
    if (body.model !== undefined && body.model) {
      validateModelForMode(effectiveKeySource, body.model, sa.mode);
      // #75: the same BYO model-vs-provider check enforced on create
      // (agent-identity.ts) was missing on edit — a key switched to a
      // different provider could keep a now-invalid model untouched.
      if (effectiveKeySource === "byo") {
        const effectiveKeyRow = keyRow ?? (sa.llmKeyId
          ? (await db.select().from(llmKeys).where(eq(llmKeys.id, sa.llmKeyId)).limit(1))[0]
          : undefined);
        if (effectiveKeyRow) {
          // Union of the provider's LIVE list (fetched with this key) + the
          // static catalog — same rule as create (agent-identity.ts).
          const ok = await isModelSelectableForKey(effectiveKeyRow, body.model,
            () => unseal(effectiveKeyRow.ciphertext, effectiveKeyRow.nonce));
          if (!ok) {
            throw new ValidationError(`model "${body.model}" is not selectable for a ${normalizeByoProvider(effectiveKeyRow.provider)} key`);
          }
        }
      }
    }
    if (!sa.repoId && body.keySource !== undefined) {
      if (body.keySource === "platform" && sa.keySource !== "platform") {
        throw new ValidationError("switch to the platform key by re-creating the deployment (metering gates run at create)");
      }
    }
    if (body.accessRoleId) {
      const role = (await db.select().from(accessRoles)
        .where(and(eq(accessRoles.id, body.accessRoleId), eq(accessRoles.ownerUserId, p.userId))).limit(1))[0];
      if (!role) throw new NotFoundError("access role");
      await db.update(agents).set({ accessRoleId: body.accessRoleId }).where(eq(agents.id, sa.agentId));
    }
    const row = await updateStandingAgent(db, sa.repoId, sa.id, {
      model: body.model, cli: body.cli, execStyle: body.execStyle, enabled: body.enabled,
      name: body.name, cpus: body.cpus, memoryMb: body.memoryMb, timeoutSec: body.timeoutSec,
      egressPolicy: body.egressPolicy, mode: body.mode, task: body.task,
      ...(llmApiKey ? { llmApiKey, llmProvider } : {}),
    });
    const standingPatch: Partial<typeof standingAgents.$inferInsert> = {};
    if (body.llmKeyId) standingPatch.llmKeyId = body.llmKeyId;
    if (body.keySource) {
      standingPatch.keySource = body.keySource;
      if (body.keySource === "platform") {
        standingPatch.llmKeyId = null;
      }
    }
    if (Object.keys(standingPatch).length > 0) {
      await db.update(standingAgents).set(standingPatch).where(eq(standingAgents.id, sa.id));
    }
    void getAuditLog(db).record({ actorKind: "human", actorId: p.userId, action: "deployment.updated", category: "agent", metadata: { standingAgentId: sa.id, fields: Object.keys(body) } });
    return c.json({ standingAgent: redactStanding(row) });
  });

  depApp.delete("/:id", async c => {
    const p = requireUser(c);
    const sa = await deploymentFor(db, p.userId, c.req.param("id"));
    await db.delete(standingAgents).where(eq(standingAgents.id, sa.id));
    void getAuditLog(db).record({ actorKind: "human", actorId: p.userId, action: "deployment.deleted", category: "agent", metadata: { standingAgentId: sa.id, name: sa.name } });
    return c.json({ ok: true });
  });

  depApp.post("/:id/run", async c => {
    // Run-now for a deployment (hub affordance): explicit repoId, or the
    // first repo in its reach. Task optional (ad-hoc instruction).
    const p = requireUser(c);
    const sa = await deploymentFor(db, p.userId, c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as { repoId?: string; task?: string };
    let repoId = typeof body.repoId === "string" ? body.repoId : sa.repoId;
    if (!repoId) {
      const reach = await resolveWorkflowRepos(db, { repoScope: "all", repoIds: [] } as never, sa);
      repoId = reach[0] ?? null;
    }
    if (!repoId) throw new ValidationError("no repos in this deployment's reach — pass repoId");
    // #120: same authorization as the workflow run-now path. `resolveWorkflowRepos`
    // already returns only reachable repos, so this bites exactly on a
    // caller-supplied body.repoId (and on a legacy pinned repoId, which passes).
    if (!(await standingAgentReachesRepoId(db, sa, repoId))) {
      throw new ForbiddenError("this deployment has no access to that repo");
    }
    const r = await dispatchStandingRun(db, events, sa, {
      manual: true, repoId, task: typeof body.task === "string" ? body.task.slice(0, 8000) : undefined, triggeredByUserId: p.userId,
    });
    return c.json({ ...r }, r.ok ? 201 : 409);
  });

  depApp.get("/:id/repos", async c => {
    // The repos this deployment currently reaches (for the workflow editor's
    // scope picker + "runs on N repos" chips).
    const p = requireUser(c);
    const sa = await deploymentFor(db, p.userId, c.req.param("id"));
    const repoIds = await resolveWorkflowRepos(db, { repoScope: "all", repoIds: [] } as never, sa);
    return c.json({ repoIds });
  });

  return { workflows: wfApp, templates: tplApp, deployments: depApp };
}
