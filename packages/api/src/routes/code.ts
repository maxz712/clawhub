import { Hono } from "hono";
import type { Context } from "hono";
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
 * Split a GitHub-style `<ref>/<path...>` slug into a ref and a path. Branch names
 * may contain slashes, so the longest branch name that prefix-matches the slug
 * wins; otherwise the first segment is the ref (a SHA or tag). Mirrors the
 * dashboard's splitRefPath so the API and the UI agree on the boundary.
 */
export function splitRefPath(slug: string, branchNames: string[]): { ref: string; path: string } {
  const joined = slug.replace(/^\/+|\/+$/g, "");
  let best = "";
  for (const b of branchNames) {
    if ((joined === b || joined.startsWith(b + "/")) && b.length > best.length) best = b;
  }
  if (best) return { ref: best, path: joined.slice(best.length).replace(/^\/+/, "") };
  const segs = joined.split("/");
  return { ref: segs[0] ?? "", path: segs.slice(1).join("/") };
}

async function serveTree(c: Context, git: GitService, ns: string, repo: string, ref: string, path: string) {
  const cleanPath = path.replace(/^\/+|\/+$/g, "");
  try {
    const entries = await git.listTree(ns, repo, ref, cleanPath);
    return c.json({ ref, path: cleanPath, entries });
  } catch {
    throw new NotFoundError(`tree ${ref}:${cleanPath}`);
  }
}

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

  // Query-param form (what the dashboard's api.ts uses): /tree?ref=&path=
  app.get("/:ns/:repo/tree", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const ref = c.req.query("ref") ?? repo.defaultBranch;
    const path = (c.req.query("path") ?? "").replace(/^\/+|\/+$/g, "");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
  });

  // GitHub-style path form: /tree/<ref>/<path...>. This mirrors the dashboard's
  // URL shape (/repos/:ns/:repo/tree/<ref>/<path>) so a direct API request to the
  // obvious path works instead of 404ing. The ROOT-of-ref cases — /tree/main and
  // /tree/main/ (trailing slash, empty path) — are explicitly handled: a bare ref
  // with no path lists the repo root.
  //
  // Branch names can contain slashes, so the ref/path boundary is resolved
  // greedily against the repo's branch list (longest matching branch wins),
  // matching the dashboard's splitRefPath. A ref that isn't a known branch (a SHA
  // or tag) is taken as the first segment.
  app.get("/:ns/:repo/tree/:ref{.+}", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    // The {.+} param captures everything after /tree/, slashes included. Strip a
    // trailing slash (the /tree/main/ case) before splitting.
    const slug = c.req.param("ref").replace(/\/+$/, "");
    const branchRows = await db.select({ name: branches.name }).from(branches).where(eq(branches.repoId, repo.id));
    const { ref, path } = splitRefPath(slug, branchRows.map(b => b.name));
    if (!ref) throw new NotFoundError("tree ref");
    return await serveTree(c, git, namespace.name, repo.name, ref, path);
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
