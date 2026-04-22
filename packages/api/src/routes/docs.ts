import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { renderRepoDoc } from "../services/docs-render.js";

export function createDocsRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();

  // Public-ish: anyone who can read the repo metadata can read rendered docs.
  app.get("/:ns/:repo/docs/*", async c => {
    const { namespace, repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    if (!repo.isPublic) return c.json({ error: "private_repo" }, 403);
    const rel = c.req.path.split("/docs/")[1] ?? "README.md";
    const sha = await git.headCommit(namespace.name, repo.name, repo.defaultBranch);
    const rendered = await renderRepoDoc(git, namespace.name, repo.name, sha, rel);
    if (!rendered) return c.json({ error: "not_found" }, 404);
    return c.json({ html: rendered.html, source: rendered.source });
  });

  return app;
}
