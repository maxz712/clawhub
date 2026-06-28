import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciPipelines, ciRuns, standingAgents } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { updateRunFromRunner } from "../services/ci-runner.js";
import { decryptRepoSecrets } from "../services/ci-secrets.js";
import { runnerAllowlistConfigured, isAllowlistedRunner } from "../services/runner-allowlist.js";
import { verifyTokenCached } from "../services/token-cache.js";
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
    // Constant-time runner-token compare (the runnerToken is a bearer credential;
    // a length-leaking/byte-leaking `!==` is a timing-oracle on a secret).
    if (!safeTokenEqual(run.runnerToken, token)) throw new AuthError("bad runner token");
    // Multi-tenant hardening: the per-run runnerToken is a transferable bearer
    // credential. When an operator runner allowlist is configured
    // (CLAWHUB_RUNNER_AGENT_IDS — the shared runner pool), require the caller to
    // ALSO present an allowlisted AGENT token, binding secrets delivery to a
    // known operator runner so a scraped runnerToken alone can't pull secrets.
    // Single-tenant deployments (no allowlist) are unchanged — there, dispatch is
    // already scoped to the repo's collaborator agents (routes/events.ts).
    // Resolve the caller's Bearer AGENT id once — used by both the operator
    // allowlist gate and the standing-run owner binding below.
    const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    let callerAgentId: string | null = null;
    if (bearer) {
      try { const p = await verifyTokenCached(bearer); if (p.kind === "agent") callerAgentId = p.agentId; } catch { /* invalid → treated as absent */ }
    }
    if (runnerAllowlistConfigured()) {
      if (!callerAgentId || !isAllowlistedRunner(callerAgentId)) throw new AuthError("secrets require an allowlisted runner agent token");
    }
    // Refuse to hand out secrets if the run is already terminal.
    if (run.status === "success" || run.status === "failure" || run.status === "skipped") {
      throw new AuthError("run is terminal; secrets locked");
    }
    if (run.standingAgentId) {
      // A standing run's secrets are the agent push JWT + BYO-LLM key — far more
      // sensitive than repo CI secrets, and the container has network. Deliver them
      // ONLY after the run is CLAIMED (status=running, the runner won the atomic
      // claim), narrowing the window for anyone who scraped the runnerToken; and
      // deliver ONLY the standing env — never merge the repo's CI secret set into a
      // network-enabled BYO container.
      if (run.status !== "running") throw new AuthError("standing-run secrets unlock only after the run is claimed");
      // Standing-run owner binding: the runnerToken is fanned out over SSE to EVERY
      // collaborator agent on the repo, so a scraped/claimed runnerToken alone must
      // not pull this standing agent's push JWT + BYO-LLM key. Even with no operator
      // allowlist, require the caller's Bearer token to resolve to the agent that
      // OWNS this run (or an allowlisted operator runner). Otherwise a co-tenant
      // collaborator could exfiltrate another standing agent's credentials.
      const sa = (await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, run.standingAgentId)).limit(1))[0];
      if (!sa) throw new NotFoundError("standing agent");
      const isOwner = callerAgentId === sa.agentId;
      const isOperator = !!callerAgentId && isAllowlistedRunner(callerAgentId);
      if (!isOwner && !isOperator) throw new AuthError("standing-run secrets require the owning agent token");
      const standing = await standingRunEnv(db, run, publicBaseUrl);
      return c.json({ secrets: standing ?? {} });
    }
    const secrets = await decryptRepoSecrets(db, run.repoId);
    return c.json({ secrets });
  });

  // Instance-wide runner presence. A `ci_runs.startedAt` is set only when a
  // runner CLAIMS a run, so "any run ever started" means a runner has connected
  // here. The dashboard uses this to warn before deploying a standing agent into
  // an instance with no runner (where ticks would queue but never execute).
  app.get("/runner-status", authMiddleware, async c => {
    const row = (await db.select({ startedAt: ciRuns.startedAt }).from(ciRuns)
      .where(sql`${ciRuns.startedAt} is not null`).orderBy(desc(ciRuns.startedAt)).limit(1))[0];
    return c.json({ everSeen: !!row, lastStartedAt: row?.startedAt ?? null });
  });

  const repoApp = new Hono();
  repoApp.use("*", authMiddleware);

  repoApp.get("/:ns/:repo/ci/pipelines", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(ciPipelines).where(eq(ciPipelines.repoId, repo.id));
    return c.json({ pipelines: rows });
  });

  repoApp.put("/:ns/:repo/ci/pipelines/:name", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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
      const updated = (await db.update(ciPipelines).set({ yaml: body.yaml, enabled: body.enabled ?? existing.enabled, triggerKind: trigger.kind, triggerConfig: trigger.config }).where(eq(ciPipelines.id, existing.id)).returning())[0];
      // Return the persisted row (matching the insert branch) so the editor can
      // reflect saved state instead of keeping the pre-save object.
      return c.json({ ok: true, pipeline: updated });
    }
    const inserted = (await db.insert(ciPipelines).values({ repoId: repo.id, name: c.req.param("name"), yaml: body.yaml, enabled: body.enabled ?? true, triggerKind: trigger.kind, triggerConfig: trigger.config }).returning())[0];
    return c.json({ pipeline: inserted }, 201);
  });

  repoApp.get("/:ns/:repo/ci/runs", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const changeId = c.req.query("change");
    const rows = changeId
      ? await db.select().from(ciRuns).where(and(eq(ciRuns.repoId, repo.id), eq(ciRuns.changeId, changeId))).orderBy(desc(ciRuns.createdAt))
      : await db.select().from(ciRuns).where(eq(ciRuns.repoId, repo.id)).orderBy(desc(ciRuns.createdAt)).limit(100);
    // Redact runner_token from list output.
    return c.json({ runs: rows.map(r => ({ ...r, runnerToken: undefined })) });
  });

  return { public: app, repo: repoApp };
}

// Constant-time string equality for bearer secrets. timingSafeEqual requires
// equal-length buffers, so the length check is done first (and the secret bytes
// are still compared in constant time relative to themselves).
function safeTokenEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
