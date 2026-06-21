import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { ValidationError } from "../services/errors.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { dropIndex, indexRepoAtCommit, search as indexSearch } from "../services/code-index.js";

export function createCodeSearchRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/code/search", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const q = c.req.query("q");
    if (!q) throw new ValidationError("q required");
    const maxHits = Math.min(Number(c.req.query("max") ?? 200), 500);
    const hits = await indexSearch(db, git, namespace.name, repo.name, repo.id, repo.defaultBranch, q, maxHits);
    return c.json({ hits });
  });

  app.post("/:ns/:repo/code/reindex", async c => {
    const { namespace, repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const sha = await git.headCommit(namespace.name, repo.name, repo.defaultBranch);
    const { indexed } = await indexRepoAtCommit(db, git, namespace.name, repo.name, repo.id, sha);
    return c.json({ indexed });
  });

  app.delete("/:ns/:repo/code/index", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await dropIndex(db, repo.id);
    return c.json({ ok: true });
  });

  return app;
}
