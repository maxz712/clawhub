import { Hono } from "hono";
import { and, desc, eq, max } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, issueComments } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";

export function createIssueRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/issues", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const status = c.req.query("status");
    const assigned = c.req.query("assigned");
    const p = c.get("tokenPayload");

    const conds = [eq(issues.repoId, repo.id)];
    if (status === "open" || status === "closed") conds.push(eq(issues.status, status));
    if (assigned === "me" && p.kind === "agent") conds.push(eq(issues.assignedAgentId, p.agentId));
    const rows = await db.select().from(issues).where(and(...conds)).orderBy(desc(issues.updatedAt)).limit(100);
    return c.json({ issues: rows });
  });

  app.post("/:ns/:repo/issues", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { title?: string; body?: string; assignedAgentId?: string; labels?: string[] };
    if (!body.title) throw new ValidationError("title required");
    const nextNumRow = await db.select({ m: max(issues.number) }).from(issues).where(eq(issues.repoId, repo.id));
    const number = (nextNumRow[0]?.m ?? 0) + 1;
    const inserted = (await db.insert(issues).values({
      repoId: repo.id,
      number,
      title: body.title,
      body: body.body,
      labels: body.labels ?? [],
      assignedAgentId: body.assignedAgentId,
      createdByKind: p.kind === "user" ? "human" : "agent",
      createdById: p.kind === "user" ? p.userId : p.agentId,
    }).returning())[0];
    await events.publish({ type: "issue.opened", repoId: repo.id, issueNumber: number, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId });
    return c.json({ issue: inserted }, 201);
  });

  app.patch("/:ns/:repo/issues/:num", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const body = await c.req.json().catch(() => ({})) as { title?: string; body?: string; status?: "open" | "closed"; assignedAgentId?: string | null };
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.body !== undefined) patch.body = body.body;
    if (body.status) patch.status = body.status;
    if (body.assignedAgentId !== undefined) patch.assignedAgentId = body.assignedAgentId;
    await db.update(issues).set(patch).where(eq(issues.id, row.id));
    if (body.status === "closed") {
      await events.publish({ type: "issue.closed", repoId: repo.id, issueNumber: number, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId });
    }
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/issues/:num/comments", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const body = await c.req.json().catch(() => ({})) as { body?: string };
    if (!body.body) throw new ValidationError("body required");
    const inserted = (await db.insert(issueComments).values({
      issueId: row.id,
      authorKind: p.kind === "user" ? "human" : "agent",
      authorId: p.kind === "user" ? p.userId : p.agentId,
      body: body.body,
    }).returning())[0];
    return c.json({ comment: inserted }, 201);
  });

  return app;
}
