import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, ciRuns, platformUsage, repositories, reviews, standingAgents, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import { resolveRepoForRead } from "../services/repo-access.js";
import { callerContextRepos } from "../services/identities.js";
import { namespaceNameOf } from "../services/namespace.js";

/**
 * v3 P4 — Workflow Runs (docs/redesign-v3.md §4): agent-origin runs presented
 * as a first-class surface, fully decoupled from CI in the UI. Under the hood
 * they remain ci_runs rows (origin='agent') on the same queue — the
 * decoupling is presentation. Rows join the acting agent identity, the
 * standing deployment, the asking human, and metered platform cost.
 */

type RunRow = typeof ciRuns.$inferSelect;

async function enrichRuns(db: DB, rows: RunRow[]) {
  const saIds = [...new Set(rows.map(r => r.standingAgentId).filter((x): x is string => !!x))];
  const sas = saIds.length ? await db.select().from(standingAgents).where(inArray(standingAgents.id, saIds)) : [];
  const saById = new Map(sas.map(s => [s.id, s]));
  const agentIds = [...new Set(sas.map(s => s.agentId))];
  const agentRows = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
  const agentById = new Map(agentRows.map(a => [a.id, a.name]));
  const userIds = [...new Set(rows.map(r => r.triggeredByUserId).filter((x): x is string => !!x))];
  const userRows = userIds.length ? await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds)) : [];
  const userById = new Map(userRows.map(u => [u.id, u.username]));
  // Metered platform cost per run (BYO runs simply have no rows here).
  const runIds = rows.map(r => r.id);
  const costs = runIds.length
    ? await db.select({ runId: platformUsage.runId, cost: sql<number>`sum(${platformUsage.costMicroUsd})` })
        .from(platformUsage).where(inArray(platformUsage.runId, runIds)).groupBy(platformUsage.runId)
    : [];
  const costByRun = new Map(costs.map(cRow => [cRow.runId, Number(cRow.cost)]));
  return rows.map(r => {
    const sa = r.standingAgentId ? saById.get(r.standingAgentId) : undefined;
    return {
      id: r.id,
      repoId: r.repoId,
      status: r.status,
      commit: r.commit,
      changeId: r.changeId,
      task: r.dispatchTask,
      issue: r.dispatchIssue,
      model: r.dispatchModel,
      mode: sa?.mode ?? null,
      workflowAgent: sa ? { standingAgentId: sa.id, name: sa.name, agentName: agentById.get(sa.agentId) ?? null } : null,
      triggeredBy: r.triggeredByUserId ? (userById.get(r.triggeredByUserId) ?? null) : null,
      costMicroUsd: costByRun.get(r.id) ?? 0,
      createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
      terminalReason: r.terminalReason ?? null,
    };
  });
}

/** Repo-scoped: GET /:ns/:repo/workflow-runs (+ /:id detail with timeline). */
export function createWorkflowRunRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/workflow-runs", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50) || 50);
    const rows = await db.select().from(ciRuns)
      .where(and(eq(ciRuns.repoId, repo.id), eq(ciRuns.origin, "agent")))
      .orderBy(desc(ciRuns.createdAt)).limit(limit);
    return c.json({ runs: await enrichRuns(db, rows) });
  });

  app.get("/:ns/:repo/workflow-runs/:id", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(ciRuns)
      .where(and(eq(ciRuns.id, c.req.param("id")), eq(ciRuns.repoId, repo.id), eq(ciRuns.origin, "agent"))).limit(1))[0];
    if (!row) throw new NotFoundError("workflow run");
    const [enriched] = await enrichRuns(db, [row]);
    // The timeline composes from existing run data — no new event table:
    // dispatched → claimed/started → steps → terminal.
    const timeline = [
      { at: row.createdAt, kind: "dispatched", detail: row.dispatchTask ?? null },
      ...(row.startedAt ? [{ at: row.startedAt, kind: "started", detail: null }] : []),
      ...((row.stepResults as Array<{ name?: string; status?: string; finishedAt?: string }> ?? []).map(s => ({
        at: s.finishedAt ?? null, kind: "step", detail: `${s.name ?? "step"}: ${s.status ?? "?"}`,
      }))),
      ...(row.finishedAt ? [{ at: row.finishedAt, kind: row.status, detail: row.terminalReason ?? null }] : []),
    ];
    // v4: an agent run PRODUCES real activity — surface the artifacts (the
    // review its agent submitted on the pinned Change, the Change it worked)
    // so the UI reads as activity, not CI plumbing.
    const produced: { reviews: Array<{ verdict: string; basis: string; submittedAt: Date | string }>; changeId: string | null } = { reviews: [], changeId: row.changeId ?? null };
    if (row.changeId && row.standingAgentId) {
      const sa = (await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, row.standingAgentId)).limit(1))[0];
      if (sa) {
        const revs = await db.select({ verdict: reviews.verdict, basis: reviews.basis, submittedAt: reviews.submittedAt })
          .from(reviews).where(and(eq(reviews.changeId, row.changeId), eq(reviews.reviewerId, sa.agentId)));
        produced.reviews = revs;
      }
    }
    return c.json({ run: { ...enriched, stepResults: row.stepResults, logUrl: row.logUrl }, timeline, produced });
  });

  return app;
}

/** Cross-repo: GET /api/v1/workflow-runs — every governed repo's agent runs. */
export function createWorkflowRunFleetRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const repos = await callerContextRepos(db, p.userId);
    if (!repos.length) return c.json({ runs: [] });
    const limit = Math.min(200, Number(c.req.query("limit") ?? 50) || 50);
    const rows = await db.select().from(ciRuns)
      .where(and(inArray(ciRuns.repoId, repos.map(r => r.id)), eq(ciRuns.origin, "agent")))
      .orderBy(desc(ciRuns.createdAt)).limit(limit);
    const enriched = await enrichRuns(db, rows);
    const labels = new Map<string, { ns: string | null; name: string }>();
    for (const r of repos) if (rows.some(x => x.repoId === r.id)) {
      labels.set(r.id, { ns: await namespaceNameOf(db, r.namespaceType, r.namespaceId), name: r.name });
    }
    return c.json({
      runs: enriched.map(r => ({ ...r, repoNs: labels.get(r.repoId)?.ns ?? null, repoName: labels.get(r.repoId)?.name ?? null })),
    });
  });
  app.get("/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const repos = await callerContextRepos(db, p.userId);
    if (!repos.length) throw new NotFoundError("repository access");
    const row = (await db.select().from(ciRuns)
      .where(and(eq(ciRuns.id, c.req.param("id")), inArray(ciRuns.repoId, repos.map(r => r.id)))).limit(1))[0];
    if (!row) throw new NotFoundError("workflow run");

    const [enriched] = await enrichRuns(db, [row]);
    const timeline = [
      { at: row.createdAt, kind: "dispatched", detail: row.dispatchTask ?? null },
      ...(row.startedAt ? [{ at: row.startedAt, kind: "started", detail: null }] : []),
      ...((row.stepResults as Array<{ name?: string; status?: string; finishedAt?: string }> ?? []).map(s => ({
        at: s.finishedAt ?? null, kind: "step", detail: `${s.name ?? "step"}: ${s.status ?? "?"}`,
      }))),
      ...(row.finishedAt ? [{ at: row.finishedAt, kind: row.status, detail: row.terminalReason ?? null }] : []),
    ];

    const produced: { reviews: Array<{ verdict: string; basis: string; submittedAt: Date | string }>; changeId: string | null } = { reviews: [], changeId: row.changeId ?? null };
    if (row.changeId && row.standingAgentId) {
      const sa = (await db.select({ agentId: standingAgents.agentId }).from(standingAgents).where(eq(standingAgents.id, row.standingAgentId)).limit(1))[0];
      if (sa) {
        const revs = await db.select({ verdict: reviews.verdict, basis: reviews.basis, submittedAt: reviews.submittedAt })
          .from(reviews).where(and(eq(reviews.changeId, row.changeId), eq(reviews.reviewerId, sa.agentId)));
        produced.reviews = revs;
      }
    }

    const targetRepo = repos.find(r => r.id === row.repoId)!;
    const nsName = await namespaceNameOf(db, targetRepo.namespaceType, targetRepo.namespaceId);

    return c.json({
      run: { ...enriched, stepResults: row.stepResults, logUrl: row.logUrl },
      timeline,
      produced,
      repoNs: nsName,
      repoName: targetRepo.name
    });
  });

  return app;
}
