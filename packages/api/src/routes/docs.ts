import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { resolveRepoForPublicRead } from "../services/repo-access.js";
import { renderRepoDoc } from "../services/docs-render.js";

export function createDocsRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();

  // Public-ish: anyone who can read the repo may read rendered docs. A denied
  // read (private repo, no/insufficient access) 404s — matching the rest of the
  // surface — so we never leak a private repo's existence with a 403.
  app.get("/:ns/:repo/docs/*", async c => {
    const caller = c.get("tokenPayload") ?? null;
    const { namespace, repo } = await resolveRepoForPublicRead(db, c.req.param("ns"), c.req.param("repo"), caller);
    const rel = c.req.path.split("/docs/")[1] ?? "README.md";
    const sha = await git.headCommit(namespace.name, repo.name, repo.defaultBranch);
    const rendered = await renderRepoDoc(git, namespace.name, repo.name, sha, rel);
    if (!rendered) return c.json({ error: "not_found" }, 404);
    return c.json({ html: rendered.html, source: rendered.source });
  });

  return app;
}
