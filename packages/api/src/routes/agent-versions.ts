import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentVersions, evalRuns, evalSuites } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { createSuite, finishEvalRun, listSuites, listVersions, promoteTier, queueEvalRun, registerVersion, startEvalRun } from "../services/agent-versions.js";

export function createAgentVersionRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/agents/:id/versions", async c => {
    const p = c.get("tokenPayload");
    const body = await c.req.json().catch(() => ({})) as { version?: string; modelName?: string; promptHash?: string; notes?: string; trustTier?: "untrusted" | "sandbox" | "standard" | "trusted" };
    if (!body.version) throw new ValidationError("version required");
    // Agents register their own; users can register for any.
    if (p.kind === "agent" && p.agentId !== c.req.param("id")) throw new AuthError("agent_scope");
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

  // External eval runner reports results.
  app.post("/evals/runs/:id/start", async c => {
    await startEvalRun(db, c.req.param("id"));
    return c.json({ ok: true });
  });
  app.post("/evals/runs/:id/finish", async c => {
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
