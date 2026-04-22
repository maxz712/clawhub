import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { releases, sbomExports } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError } from "../services/errors.js";
import { autoGenerateForRelease, getLatestSbom } from "../services/sbom.js";

export function createSbomRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/releases/:id/sbom", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const release = (await db.select().from(releases).where(and(eq(releases.id, c.req.param("id")), eq(releases.repoId, repo.id))).limit(1))[0];
    if (!release) throw new NotFoundError("release");
    const latest = await getLatestSbom(db, release.id);
    if (!latest) return c.json({ sbom: null });
    return c.json({ sbom: latest });
  });

  app.post("/:ns/:repo/releases/:id/sbom", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const release = (await db.select().from(releases).where(and(eq(releases.id, c.req.param("id")), eq(releases.repoId, repo.id))).limit(1))[0];
    if (!release) throw new NotFoundError("release");

    // We know release.tag but may not have a commit; use head of default branch as the snapshot point.
    const commit = await git.headCommit(namespace.name, repo.name, repo.defaultBranch);
    const doc = await autoGenerateForRelease(db, git, {
      releaseId: release.id,
      namespace: namespace.name,
      repo: repo.name,
      repoId: repo.id,
      commit,
      releaseTag: release.tag,
    });
    return c.json({ sbom: doc }, 201);
  });

  app.get("/:ns/:repo/sboms", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    // List SBOMs by joining through releases.
    const rows = await db.select({ s: sbomExports, r: releases })
      .from(sbomExports).innerJoin(releases, eq(releases.id, sbomExports.releaseId))
      .where(eq(releases.repoId, repo.id))
      .orderBy(desc(sbomExports.createdAt));
    return c.json({ exports: rows.map(x => ({ id: x.s.id, releaseTag: x.r.tag, format: x.s.format, createdAt: x.s.createdAt })) });
  });

  return app;
}
