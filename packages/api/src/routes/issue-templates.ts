import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { issueTemplates } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";

export function createIssueTemplateRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/issue-templates", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(issueTemplates).where(eq(issueTemplates.repoId, repo.id));
    return c.json({ templates: rows });
  });

  app.put("/:ns/:repo/issue-templates/:name", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => ({})) as { title?: string; body?: string; labels?: string[] };
    if (!name) throw new ValidationError("name required");
    const [row] = await db.insert(issueTemplates).values({
      repoId: repo.id,
      name,
      title: body.title ?? "",
      body: body.body ?? "",
      labels: body.labels ?? [],
    }).onConflictDoUpdate({
      target: [issueTemplates.repoId, issueTemplates.name],
      set: { title: body.title ?? "", body: body.body ?? "", labels: body.labels ?? [] },
    }).returning();
    return c.json({ template: row });
  });

  app.delete("/:ns/:repo/issue-templates/:name", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const res = await db.delete(issueTemplates).where(and(eq(issueTemplates.repoId, repo.id), eq(issueTemplates.name, c.req.param("name")))).returning();
    if (!res.length) throw new NotFoundError("template");
    return c.json({ ok: true });
  });

  return app;
}
