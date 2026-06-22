import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { DB } from "../models/db.js";
import type { EventBus } from "../services/events.js";
import { changes, reviewComments } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { resolveAndRecordMentions } from "../services/mentions.js";
import { deliverMentions } from "../services/notifications.js";

export function createCommentRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/changes/:id/comments", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const rows = await db.select().from(reviewComments).where(eq(reviewComments.changeId, change.id)).orderBy(asc(reviewComments.createdAt));

    const threads: Record<string, typeof rows> = {};
    for (const r of rows) (threads[r.threadId] ??= []).push(r);
    return c.json({ threads: Object.entries(threads).map(([id, comments]) => ({
      id,
      path: comments[0].path,
      line: comments[0].line,
      side: comments[0].side,
      resolved: comments[0].resolved,
      resolvedAt: comments[0].resolvedAt,
      resolvedBy: comments[0].resolvedBy,
      comments,
    })) });
  });

  app.post("/:ns/:repo/changes/:id/comments", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as {
      threadId?: string;
      parentId?: string;
      path?: string;
      line?: number;
      side?: "old" | "new";
      body?: string;
      suggestion?: string;
    };
    if (!body.body?.trim()) throw new ValidationError("comment body required");

    const authorKind = p.kind === "user" ? "human" : "agent";
    const authorId = p.kind === "user" ? p.userId : p.agentId;

    let threadId = body.threadId;
    let path = body.path;
    let line = body.line;
    let side = body.side ?? "new";

    if (!threadId) {
      if (!path || typeof line !== "number") throw new ValidationError("path and line required for new thread");
      threadId = uuidv4();
    } else {
      const existing = (await db.select().from(reviewComments).where(and(eq(reviewComments.threadId, threadId), eq(reviewComments.changeId, change.id))).limit(1))[0];
      if (!existing) throw new NotFoundError("thread");
      path = existing.path;
      line = existing.line;
      side = existing.side as "old" | "new";
    }

    const [inserted] = await db.insert(reviewComments).values({
      changeId: change.id,
      threadId,
      parentId: body.parentId ?? null,
      path: path!,
      line: line!,
      side,
      body: body.body,
      suggestion: body.suggestion ?? null,
      authorKind,
      authorId,
    }).returning();

    const mentioned = await resolveAndRecordMentions(db, body.body, {
      repoId: repo.id,
      sourceKind: "review_comment",
      sourceId: inserted.id,
      author: { kind: authorKind, id: authorId },
    });
    const ns = c.req.param("ns"), repoName = c.req.param("repo");
    await deliverMentions(db, mentioned, {
      repoId: repo.id, repoFullName: `${ns}/${repoName}`,
      link: `/repos/${ns}/${repoName}/changes/${change.id}`,
      sourceKind: "review_comment", sourceId: inserted.id, snippet: body.body,
      actor: { kind: authorKind, id: authorId },
    });

    await events.publish({
      type: "comment.created",
      repoId: repo.id,
      changeId: change.id,
      actorKind: authorKind,
      actorId: authorId,
      payload: { threadId, path, line },
    });

    return c.json({ comment: inserted }, 201);
  });

  app.post("/:ns/:repo/changes/:id/comments/:threadId/resolve", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const threadId = c.req.param("threadId");
    const actorId = p.kind === "user" ? p.userId : p.agentId;

    await db.update(reviewComments)
      .set({ resolved: true, resolvedAt: new Date(), resolvedBy: actorId })
      .where(and(eq(reviewComments.changeId, change.id), eq(reviewComments.threadId, threadId)));

    await events.publish({
      type: "comment.resolved",
      repoId: repo.id,
      changeId: change.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId,
      payload: { threadId },
    });
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/changes/:id/comments/:threadId/unresolve", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const threadId = c.req.param("threadId");
    await db.update(reviewComments)
      .set({ resolved: false, resolvedAt: null, resolvedBy: null })
      .where(and(eq(reviewComments.changeId, change.id), eq(reviewComments.threadId, threadId)));
    return c.json({ ok: true });
  });

  return app;
}
