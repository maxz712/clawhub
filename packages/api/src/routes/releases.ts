import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, releaseAssets, releases } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { generateReleaseNotes } from "../services/release-notes.js";

export function createReleaseRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/releases", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(releases).where(eq(releases.repoId, repo.id)).orderBy(desc(releases.createdAt));
    return c.json({ releases: rows });
  });

  app.get("/:ns/:repo/releases/generate-notes", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const sincePrevious = c.req.query("since") !== "all";
    const body = await generateReleaseNotes(db, repo.id, { sincePrevious });
    return c.json({ body });
  });

  app.post("/:ns/:repo/releases", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { tag?: string; title?: string; body?: string; changeId?: string; autoGenerateNotes?: boolean };
    if (!body.tag || !body.changeId) throw new ValidationError("tag and changeId required");
    const change = (await db.select().from(changes).where(and(eq(changes.id, body.changeId), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    if (change.status !== "merged") throw new ValidationError("release must reference a merged change");

    let notesBody = body.body ?? "";
    if (body.autoGenerateNotes) {
      const generated = await generateReleaseNotes(db, repo.id, { sincePrevious: true });
      notesBody = notesBody ? `${notesBody}\n\n${generated}` : generated;
    }

    const inserted = (await db.insert(releases).values({
      repoId: repo.id, tag: body.tag, title: body.title ?? body.tag, body: notesBody, changeId: change.id,
    }).returning())[0];
    await events.publish({ type: "release.created", repoId: repo.id, changeId: change.id, payload: { tag: body.tag } });
    return c.json({ release: inserted }, 201);
  });

  app.get("/:ns/:repo/releases/:id/assets", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, c.req.param("id")));
    return c.json({ assets: rows, repoId: repo.id });
  });

  app.post("/:ns/:repo/releases/:id/assets", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const release = (await db.select().from(releases).where(and(eq(releases.id, c.req.param("id")), eq(releases.repoId, repo.id))).limit(1))[0];
    if (!release) throw new NotFoundError("release");
    const body = await c.req.json().catch(() => ({})) as { name?: string; url?: string; size?: number; contentType?: string; checksum?: string };
    if (!body.name || !body.url) throw new ValidationError("name and url required");
    const [asset] = await db.insert(releaseAssets).values({
      releaseId: release.id,
      name: body.name,
      url: body.url,
      size: body.size ?? 0,
      contentType: body.contentType ?? "application/octet-stream",
      checksum: body.checksum ?? null,
    }).returning();
    return c.json({ asset }, 201);
  });

  app.delete("/:ns/:repo/releases/:id/assets/:assetId", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const release = (await db.select().from(releases).where(and(eq(releases.id, c.req.param("id")), eq(releases.repoId, repo.id))).limit(1))[0];
    if (!release) throw new NotFoundError("release");
    await db.delete(releaseAssets).where(and(eq(releaseAssets.id, c.req.param("assetId")), eq(releaseAssets.releaseId, release.id)));
    return c.json({ ok: true });
  });

  return app;
}
