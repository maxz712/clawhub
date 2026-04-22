import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciArtifacts, ciRuns } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";

export function createArtifactRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/ci/runs/:runId/artifacts", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const runId = c.req.param("runId");
    const rows = await db.select().from(ciArtifacts).where(and(eq(ciArtifacts.runId, runId), eq(ciArtifacts.repoId, repo.id)));
    return c.json({ artifacts: rows });
  });

  // Runner-authenticated upload registration: the runner supplies an external URL where the artifact is stored.
  app.post("/:ns/:repo/ci/runs/:runId/artifacts", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent" && p.kind !== "user") throw new AuthError("unauthenticated");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const runId = c.req.param("runId");
    const run = (await db.select().from(ciRuns).where(and(eq(ciRuns.id, runId), eq(ciRuns.repoId, repo.id))).limit(1))[0];
    if (!run) throw new NotFoundError("ci run");

    const body = await c.req.json().catch(() => ({})) as { name?: string; url?: string; size?: number; contentType?: string; checksum?: string };
    if (!body.name || !body.url) throw new ValidationError("name and url required");

    const [inserted] = await db.insert(ciArtifacts).values({
      runId,
      repoId: repo.id,
      name: body.name,
      url: body.url,
      size: body.size ?? 0,
      contentType: body.contentType ?? "application/octet-stream",
      checksum: body.checksum ?? null,
    }).returning();

    return c.json({ artifact: inserted }, 201);
  });

  app.delete("/:ns/:repo/ci/runs/:runId/artifacts/:artifactId", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const runId = c.req.param("runId");
    const artifactId = c.req.param("artifactId");
    await db.delete(ciArtifacts).where(and(eq(ciArtifacts.id, artifactId), eq(ciArtifacts.runId, runId), eq(ciArtifacts.repoId, repo.id)));
    return c.json({ ok: true });
  });

  return app;
}
