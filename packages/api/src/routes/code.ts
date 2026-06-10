import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError } from "../services/errors.js";
import { renderMarkdown } from "../services/docs-render.js";

const MAX_BLOB_BYTES = 512 * 1024;
const README_CANDIDATES = ["README.md", "readme.md", "Readme.md", "README"];

/**
 * Read-only code browsing for the dashboard: directory listings, file
 * contents, and the rendered README. Mounted under /api/v1/repos.
 */
export function createCodeRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/branches", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(branches).where(eq(branches.repoId, repo.id));
    return c.json({
      branches: rows
        .map(b => ({ name: b.name, headCommit: b.headCommit, isDefault: b.name === repo.defaultBranch }))
        .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)),
    });
  });

  app.get("/:ns/:repo/tree", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+|\/+$/g, "");
    try {
      const entries = await git.listTree(namespace.name, repo.name, ref, path);
      return c.json({ ref, path, entries });
    } catch {
      throw new NotFoundError(`tree ${ref}:${path}`);
    }
  });

  app.get("/:ns/:repo/blob", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+/, "");
    if (!path) throw new NotFoundError("blob path");
    const content = await git.fileAt(namespace.name, repo.name, ref, path);
    if (content === null) throw new NotFoundError(`blob ${ref}:${path}`);
    const binary = content.includes("\0");
    const truncated = content.length > MAX_BLOB_BYTES;
    return c.json({
      ref, path,
      size: content.length,
      binary,
      truncated,
      content: binary ? null : content.slice(0, MAX_BLOB_BYTES),
    });
  });

  app.get("/:ns/:repo/readme", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    for (const name of README_CANDIDATES) {
      const content = await git.fileAt(namespace.name, repo.name, ref, name);
      if (content !== null) return c.json({ ref, name, html: renderMarkdown(content) });
    }
    return c.json({ ref, name: null, html: null });
  });

  return app;
}
