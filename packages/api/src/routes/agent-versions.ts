import { Hono } from "hono";
import type { Context } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentVersions, agents, evalRuns, evalSuites } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { createSuite, finishEvalRun, listSuites, listVersions, promoteTier, queueEvalRun, registerVersion, startEvalRun } from "../services/agent-versions.js";

// Platform admins (CLAWHUB_ADMIN_EMAILS) may act on any agent. Mirrors routes/admin.ts.
const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
function isAdmin(p: { kind: string; email?: string }): boolean {
  return p.kind === "user" && !!p.email && ADMIN_SET.has(p.email.toLowerCase());
}

export function createAgentVersionRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // The caller controls an agent if it IS that agent, owns it (associated /
  // service user), or is a platform admin. Used to scope version registration,
  // tier promotion, and eval run reporting to the agent's owner — without it any
  // user could register versions / promote trust tiers on ANOTHER agent. Missing
  // agent → 404 (no existence leak).
  async function requireAgentControl(c: Context, agentId: string): Promise<void> {
    const p = c.get("tokenPayload");
    if (p.kind === "agent") {
      if (p.agentId !== agentId) throw new AuthError("agent_scope");
      return;
    }
    if (isAdmin(p)) return;
    const a = (await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, agentId), or(eq(agents.associatedUserId, p.userId), eq(agents.serviceUserId, p.userId)))).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
  }

  app.post("/agents/:id/versions", async c => {
    const body = await c.req.json().catch(() => ({})) as { version?: string; modelName?: string; promptHash?: string; notes?: string; trustTier?: "untrusted" | "sandbox" | "standard" | "trusted" };
    if (!body.version) throw new ValidationError("version required");
    // Agents register their own; a user must own the target agent (not "any").
    // trustTier here is a self-asserted floor; eval promotion is the earned path.
    await requireAgentControl(c, c.req.param("id"));
    const row = await registerVersion(db, { agentId: c.req.param("id"), version: body.version, modelName: body.modelName, promptHash: body.promptHash, notes: body.notes, trustTier: body.trustTier });
    return c.json({ version: row }, 201);
  });

  app.get("/agents/:id/versions", async c => {
    const rows = await listVersions(db, c.req.param("id"));
    return c.json({ versions: rows });
  });

  app.post("/agents/:id/versions/:versionId/tier", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Promoting a trust tier is a governance act on a SPECIFIC agent — require the
    // caller own that agent (or be admin), and confirm the version is actually its
    // own (so :id can't be spoofed to a controlled agent to promote another's version).
    await requireAgentControl(c, c.req.param("id"));
    const version = (await db.select().from(agentVersions).where(eq(agentVersions.id, c.req.param("versionId"))).limit(1))[0];
    if (!version || version.agentId !== c.req.param("id")) throw new NotFoundError("version");
    const body = await c.req.json().catch(() => ({})) as { trustTier?: "untrusted" | "sandbox" | "standard" | "trusted" };
    if (!body.trustTier) throw new ValidationError("trustTier required");
    const row = await promoteTier(db, c.req.param("versionId"), body.trustTier);
    return c.json({ version: row });
  });

  app.get("/evals/suites", async c => c.json({ suites: await listSuites(db) }));

  app.post("/evals/suites", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { name?: string; description?: string; cases?: unknown; passingThreshold?: number };
    if (!body.name || !Array.isArray(body.cases)) throw new ValidationError("name + cases required");
    const row = await createSuite(db, { name: body.name, description: body.description, cases: body.cases as Parameters<typeof createSuite>[1]["cases"], passingThreshold: body.passingThreshold });
    return c.json({ suite: row }, 201);
  });

  app.post("/evals/runs", async c => {
    const p = c.get("tokenPayload");
    const body = await c.req.json().catch(() => ({})) as { suiteId?: string; agentId?: string; agentVersionId?: string };
    if (!body.suiteId || !body.agentId) throw new ValidationError("suiteId + agentId required");
    if (p.kind === "agent" && p.agentId !== body.agentId) throw new AuthError("agent_scope");
    const row = await queueEvalRun(db, body.suiteId, body.agentId, body.agentVersionId);
    return c.json({ run: row }, 201);
  });

  // External eval runner reports results. Scope to the run's agent: finishing a
  // run auto-PROMOTES the version's trust tier, so an open /finish let any user
  // (or unrelated agent) grant trust to ANY agent. Require the caller control the
  // run's agent (own it, be that agent, or admin). Missing run → 404.
  async function requireRunControl(c: Context, runId: string): Promise<void> {
    const run = (await db.select({ agentId: evalRuns.agentId }).from(evalRuns).where(eq(evalRuns.id, runId)).limit(1))[0];
    if (!run) throw new NotFoundError("eval run");
    await requireAgentControl(c, run.agentId);
  }

  app.post("/evals/runs/:id/start", async c => {
    await requireRunControl(c, c.req.param("id"));
    await startEvalRun(db, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/evals/runs/:id/finish", async c => {
    await requireRunControl(c, c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as { results?: Array<{ name: string; passed: boolean; score: number; notes?: string; actual?: Record<string, unknown> }> };
    if (!Array.isArray(body.results)) throw new ValidationError("results required");
    const result = await finishEvalRun(db, c.req.param("id"), body.results);
    return c.json(result);
  });

  app.get("/evals/runs/:id", async c => {
    const r = (await db.select().from(evalRuns).where(eq(evalRuns.id, c.req.param("id"))).limit(1))[0];
    if (!r) throw new NotFoundError("eval run");
    const suite = (await db.select().from(evalSuites).where(eq(evalSuites.id, r.suiteId)).limit(1))[0];
    return c.json({ run: r, suite });
  });

  app.get("/agents/:id/evals", async c => {
    const runs = await db.select().from(evalRuns).where(eq(evalRuns.agentId, c.req.param("id"))).orderBy(desc(evalRuns.createdAt)).limit(50);
    return c.json({ runs });
  });

  return app;
}
