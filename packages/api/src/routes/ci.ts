import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines, ciRuns } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { updateRunFromRunner } from "../services/ci-runner.js";
import { decryptRepoSecrets } from "../services/ci-secrets.js";
import { standingRunEnv } from "../services/standing-agents.js";
import { parsePipelineTrigger } from "../services/ci-yaml.js";
import { parseCron } from "../services/cron.js";

export function createCiRoutes(db: DB, events: EventBus, publicBaseUrl = process.env.CLAWHUB_PUBLIC_URL ?? "https://useclawhub.com"): { public: Hono; repo: Hono } {
  const app = new Hono();

  // Public runner callback (auth via per-run token in body).
  app.post("/runs/:id", async c => {
    // Accept both snake_case (documented) and camelCase (what the bundled
    // runner sends): the field-name mismatch silently dropped step output,
    // so failed runs carried no trace of why they failed.
    const body = await c.req.json().catch(() => ({})) as { runner_token?: string; runnerToken?: string; status?: string; log_url?: string; logUrl?: string; step_results?: unknown[]; stepResults?: unknown[] };
    const runnerToken = body.runner_token ?? body.runnerToken;
    if (!runnerToken || !body.status) throw new ValidationError("runner_token and status required");
    await updateRunFromRunner(db, events, c.req.param("id"), runnerToken, {
      status: body.status as "running" | "success" | "failure" | "skipped",
      logUrl: body.log_url ?? body.logUrl,
      stepResults: body.step_results ?? body.stepResults,
    });
    return c.json({ ok: true });
  });

  // Runner pulls decrypted secrets for its run. Header: X-Runner-Token.
  app.get("/runs/:id/secrets", async c => {
    const token = c.req.header("x-runner-token");
    if (!token) throw new AuthError("missing runner token");
    const run = (await db.select().from(ciRuns).where(eq(ciRuns.id, c.req.param("id"))).limit(1))[0];
    if (!run) throw new NotFoundError("ci run");
    if (run.runnerToken !== token) throw new AuthError("bad runner token");
    // Refuse to hand out secrets if the run is already terminal.
    if (run.status === "success" || run.status === "failure" || run.status === "skipped") {
      throw new AuthError("run is terminal; secrets locked");
    }
    const secrets = await decryptRepoSecrets(db, run.repoId);
    // Standing-agent runs additionally receive the (sealed) agent push token + LLM
    // creds + ClawHub context, unsealed here behind the per-run runnerToken and
    // delivered only to the claiming runner. Standing env wins on key conflicts.
    const standing = await standingRunEnv(db, run, publicBaseUrl);
    return c.json({ secrets: standing ? { ...secrets, ...standing } : secrets });
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
    // Derive the structured trigger from the YAML `on:` and persist it as a
    // queryable column so the scheduler loop + event fan-out can index pipelines
    // by kind without re-parsing every repo's YAML on each tick.
    const trigger = parsePipelineTrigger(body.yaml);
    // A schedule pipeline must declare a parseable cron — reject early so the
    // agent learns at config time, not silently never running.
    if (trigger.kind === "schedule") {
      if (!trigger.config.cron) throw new ValidationError("on: schedule requires a `cron:` 5-field expression");
      try { parseCron(trigger.config.cron); }
      catch (e) { throw new ValidationError(`invalid cron: ${(e as Error).message}`); }
    }
    if (trigger.kind === "event" && !trigger.config.event) throw new ValidationError("on: event requires an `event:` type");
    const existing = (await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repo.id), eq(ciPipelines.name, c.req.param("name")))).limit(1))[0];
    if (existing) {
      await db.update(ciPipelines).set({ yaml: body.yaml, enabled: body.enabled ?? existing.enabled, triggerKind: trigger.kind, triggerConfig: trigger.config }).where(eq(ciPipelines.id, existing.id));
      return c.json({ ok: true });
    }
    const inserted = (await db.insert(ciPipelines).values({ repoId: repo.id, name: c.req.param("name"), yaml: body.yaml, enabled: body.enabled ?? true, triggerKind: trigger.kind, triggerConfig: trigger.config }).returning())[0];
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
