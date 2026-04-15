import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines, ciRuns } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { updateRunFromRunner } from "../services/ci-runner.js";

export function createCiRoutes(db: DB, events: EventBus): { public: Hono; repo: Hono } {
  const app = new Hono();

  // Public runner callback (auth via per-run token in body).
  app.post("/runs/:id", async c => {
    const body = await c.req.json().catch(() => ({})) as { runner_token?: string; status?: string; log_url?: string; step_results?: unknown[] };
    if (!body.runner_token || !body.status) throw new ValidationError("runner_token and status required");
    await updateRunFromRunner(db, events, c.req.param("id"), body.runner_token, {
      status: body.status as "running" | "success" | "failure" | "skipped",
      logUrl: body.log_url,
      stepResults: body.step_results,
    });
    return c.json({ ok: true });
  });

  const repoApp = new Hono();
  repoApp.use("*", authMiddleware);

  repoApp.get("/:ns/:repo/ci/pipelines", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(ciPipelines).where(eq(ciPipelines.repoId, repo.id));
    return c.json({ pipelines: rows });
  });

  repoApp.put("/:ns/:repo/ci/pipelines/:name", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { yaml?: string; enabled?: boolean };
    if (!body.yaml) throw new ValidationError("yaml required");
    const existing = (await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repo.id), eq(ciPipelines.name, c.req.param("name")))).limit(1))[0];
    if (existing) {
      await db.update(ciPipelines).set({ yaml: body.yaml, enabled: body.enabled ?? existing.enabled }).where(eq(ciPipelines.id, existing.id));
      return c.json({ ok: true });
    }
    const inserted = (await db.insert(ciPipelines).values({ repoId: repo.id, name: c.req.param("name"), yaml: body.yaml, enabled: body.enabled ?? true }).returning())[0];
    return c.json({ pipeline: inserted }, 201);
  });

  repoApp.get("/:ns/:repo/ci/runs", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const changeId = c.req.query("change");
    const rows = changeId
      ? await db.select().from(ciRuns).where(and(eq(ciRuns.repoId, repo.id), eq(ciRuns.changeId, changeId))).orderBy(desc(ciRuns.createdAt))
      : await db.select().from(ciRuns).where(eq(ciRuns.repoId, repo.id)).orderBy(desc(ciRuns.createdAt)).limit(100);
    // Redact runner_token from list output.
    return c.json({ runs: rows.map(r => ({ ...r, runnerToken: undefined })) });
  });

  return { public: app, repo: repoApp };
}
