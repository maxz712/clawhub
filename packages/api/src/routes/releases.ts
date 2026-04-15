import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, releases } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";

export function createReleaseRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/releases", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(releases).where(eq(releases.repoId, repo.id)).orderBy(desc(releases.createdAt));
    return c.json({ releases: rows });
  });

  app.post("/:ns/:repo/releases", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { tag?: string; title?: string; body?: string; changeId?: string };
    if (!body.tag || !body.changeId) throw new ValidationError("tag and changeId required");
    const change = (await db.select().from(changes).where(and(eq(changes.id, body.changeId), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    if (change.status !== "merged") throw new ValidationError("release must reference a merged change");
    const inserted = (await db.insert(releases).values({ repoId: repo.id, tag: body.tag, title: body.title ?? body.tag, body: body.body, changeId: change.id }).returning())[0];
    await events.publish({ type: "release.created", repoId: repo.id, changeId: change.id, payload: { tag: body.tag } });
    return c.json({ release: inserted }, 201);
  });

  return app;
}
