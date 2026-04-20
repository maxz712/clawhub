import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issues, milestones } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";

export function createMilestoneRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/milestones", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(milestones).where(eq(milestones.repoId, repo.id)).orderBy(desc(milestones.createdAt));
    return c.json({ milestones: rows });
  });

  app.post("/:ns/:repo/milestones", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { title?: string; description?: string; dueDate?: string };
    if (!body.title?.trim()) throw new ValidationError("title required");
    const [m] = await db.insert(milestones).values({
      repoId: repo.id,
      title: body.title,
      description: body.description ?? null,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
    }).returning();
    return c.json({ milestone: m }, 201);
  });

  app.patch("/:ns/:repo/milestones/:id", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { title?: string; description?: string; dueDate?: string; status?: "open" | "closed" };
    const patch: Record<string, unknown> = {};
    if (body.title) patch.title = body.title;
    if ("description" in body) patch.description = body.description ?? null;
    if ("dueDate" in body) patch.dueDate = body.dueDate ? new Date(body.dueDate) : null;
    if (body.status && ["open", "closed"].includes(body.status)) patch.status = body.status;
    const [row] = await db.update(milestones).set(patch).where(and(eq(milestones.id, c.req.param("id")), eq(milestones.repoId, repo.id))).returning();
    if (!row) throw new NotFoundError("milestone");
    return c.json({ milestone: row });
  });

  app.delete("/:ns/:repo/milestones/:id", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await db.update(issues).set({ milestoneId: null }).where(and(eq(issues.milestoneId, c.req.param("id")), eq(issues.repoId, repo.id)));
    await db.delete(milestones).where(and(eq(milestones.id, c.req.param("id")), eq(milestones.repoId, repo.id)));
    return c.json({ ok: true });
  });

  return app;
}
