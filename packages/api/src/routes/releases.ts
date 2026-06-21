import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, changes, releaseAssets, releases } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { generateReleaseNotes } from "../services/release-notes.js";

export interface ReleaseTargetInput {
  repoId: string;
  defaultBranch: string;
  tag?: string;
  changeId?: string;
  commit?: string;
}

/**
 * Validate a release request and resolve what it points at.
 *
 * - `tag` is required.
 * - `changeId` is OPTIONAL. When given it must be a merged Change in this repo
 *   (the original contract). When omitted, the release is cut straight off the
 *   branch.
 * - `commit` defaults to the repo's default-branch HEAD (from the branches
 *   table) when neither commit nor changeId is supplied — so you can tag current
 *   main without first opening a Change.
 */
export async function resolveReleaseTarget(db: DB, input: ReleaseTargetInput): Promise<{ tag: string; changeId: string | null; commit: string | undefined }> {
  if (!input.tag) throw new ValidationError("tag required");
  const tag = input.tag;

  let changeId: string | null = null;
  if (input.changeId) {
    const change = (await db.select().from(changes).where(and(eq(changes.id, input.changeId), eq(changes.repoId, input.repoId))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    if (change.status !== "merged") throw new ValidationError("release must reference a merged change");
    changeId = change.id;
  }

  let commit = input.commit;
  if (!commit) {
    const head = (await db.select().from(branches).where(and(eq(branches.repoId, input.repoId), eq(branches.name, input.defaultBranch))).limit(1))[0];
    commit = head?.headCommit;
  }
  return { tag, changeId, commit };
}

export function createReleaseRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/releases", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(releases).where(eq(releases.repoId, repo.id)).orderBy(desc(releases.createdAt));
    return c.json({ releases: rows });
  });

  app.get("/:ns/:repo/releases/generate-notes", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const sincePrevious = c.req.query("since") !== "all";
    const body = await generateReleaseNotes(db, repo.id, { sincePrevious });
    return c.json({ body });
  });

  app.post("/:ns/:repo/releases", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { tag?: string; title?: string; body?: string; changeId?: string; commit?: string; autoGenerateNotes?: boolean };
    const { tag, changeId, commit } = await resolveReleaseTarget(db, {
      repoId: repo.id, defaultBranch: repo.defaultBranch, tag: body.tag, changeId: body.changeId, commit: body.commit,
    });

    let notesBody = body.body ?? "";
    if (body.autoGenerateNotes) {
      const generated = await generateReleaseNotes(db, repo.id, { sincePrevious: true });
      notesBody = notesBody ? `${notesBody}\n\n${generated}` : generated;
    }

    const inserted = (await db.insert(releases).values({
      repoId: repo.id, tag, title: body.title ?? tag, body: notesBody, changeId,
    }).returning())[0];
    await events.publish({ type: "release.created", repoId: repo.id, changeId: changeId ?? undefined, payload: { tag, commit } });
    return c.json({ release: inserted }, 201);
  });

  app.get("/:ns/:repo/releases/:id/assets", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(releaseAssets).where(eq(releaseAssets.releaseId, c.req.param("id")));
    return c.json({ assets: rows, repoId: repo.id });
  });

  app.post("/:ns/:repo/releases/:id/assets", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const release = (await db.select().from(releases).where(and(eq(releases.id, c.req.param("id")), eq(releases.repoId, repo.id))).limit(1))[0];
    if (!release) throw new NotFoundError("release");
    await db.delete(releaseAssets).where(and(eq(releaseAssets.id, c.req.param("assetId")), eq(releaseAssets.releaseId, release.id)));
    return c.json({ ok: true });
  });

  return app;
}
