import { Hono } from "hono";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { auditEvents } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";

export function createAuditRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/audit", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const category = c.req.query("category");
    const action = c.req.query("action");
    const before = c.req.query("before");
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);

    const filters = [eq(auditEvents.repoId, repo.id)];
    if (category) filters.push(eq(auditEvents.category, category));
    if (action) filters.push(eq(auditEvents.action, action));
    if (before) filters.push(lt(auditEvents.createdAt, new Date(before)));

    const rows = await db.select().from(auditEvents)
      .where(and(...filters))
      .orderBy(desc(auditEvents.createdAt))
      .limit(limit);

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(auditEvents).where(eq(auditEvents.repoId, repo.id));

    return c.json({ events: rows, total: Number(total) });
  });

  return app;
}
