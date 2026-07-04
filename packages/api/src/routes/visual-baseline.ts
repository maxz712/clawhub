// Visual regression baselines (N4). Per (repo, surface-key) the approved
// screenshot: PUT a PNG to set/replace it, GET to fetch it (for the harness to
// pixel-compare against, or the dashboard to show). A verify run captures the same
// surface and compares against this via visual-diff.mjs in-harness. The bytes live
// in the evidence object store; the row is the pointer + provenance.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { visualBaselines } from "../models/schema.js";
import type { ObjectStore } from "../services/object-store.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";

const KEY_RE = /^[A-Za-z0-9._/-]{1,200}$/;

export function createVisualBaselineRoutes(db: DB, store: ObjectStore): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // List baselines for a repo (metadata only).
  app.get("/:ns/:repo/visual-baselines", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select({ key: visualBaselines.key, blobId: visualBaselines.blobId, headCommit: visualBaselines.headCommit, updatedAt: visualBaselines.updatedAt })
      .from(visualBaselines).where(eq(visualBaselines.repoId, repo.id));
    return c.json({ baselines: rows });
  });

  // Set/replace the baseline PNG for a surface key. Write access — a baseline is
  // the "approved look", so it's a governance write (repo write, incl. the verify agent).
  app.put("/:ns/:repo/visual-baselines/:key", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const key = decodeURIComponent(c.req.param("key"));
    if (!KEY_RE.test(key)) throw new ValidationError("bad baseline key");
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length === 0) throw new ValidationError("empty body");
    if (buf.length > 16 * 1024 * 1024) throw new ValidationError("baseline too large (>16MB)");
    const blobId = `${randomUUID()}.png`;
    await store.put(`visual-baseline/${repo.id}/${blobId}`, buf, "image/png");
    const headCommit = c.req.query("headCommit") ?? null;
    const approvedByUserId = p.kind === "user" ? p.userId : null;
    await db.insert(visualBaselines).values({ repoId: repo.id, key, blobId, headCommit, approvedByUserId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [visualBaselines.repoId, visualBaselines.key], set: { blobId, headCommit, approvedByUserId, updatedAt: new Date() } });
    return c.json({ ok: true, key, blobId, size: buf.length }, 201);
  });

  // Fetch the baseline PNG bytes for a surface key.
  app.get("/:ns/:repo/visual-baselines/:key", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const key = decodeURIComponent(c.req.param("key"));
    const row = (await db.select().from(visualBaselines).where(and(eq(visualBaselines.repoId, repo.id), eq(visualBaselines.key, key))).limit(1))[0];
    if (!row) throw new NotFoundError("baseline");
    const obj = await store.get(`visual-baseline/${repo.id}/${row.blobId}`);
    if (!obj) throw new NotFoundError("baseline blob");
    const chunks: Buffer[] = [];
    for await (const ch of obj.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(ch));
    c.header("content-type", "image/png");
    c.header("cache-control", "no-store");
    return c.body(Buffer.concat(chunks));
  });

  app.delete("/:ns/:repo/visual-baselines/:key", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.delete(visualBaselines).where(and(eq(visualBaselines.repoId, repo.id), eq(visualBaselines.key, decodeURIComponent(c.req.param("key")))));
    return c.json({ ok: true });
  });

  return app;
}
