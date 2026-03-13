import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { repositories } from "../models/schema.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";

export function createFileRoutes(db: Database, gitService: GitService) {
  const app = new Hono();

  // Helper to load repo by ID
  async function getRepo(repoId: string) {
    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }
    return repo;
  }

  // GET /api/v1/repos/:id/files — List files in the repo
  // Also handles GET /api/v1/repos/:id/files/* — Get file contents
  // We use a single wildcard handler and distinguish by whether there's a subpath
  app.get("/*", async (c) => {
    // The parent route mounts this under /repos/:id/files
    // so c.req.path is the full path. We need to extract repo ID and filepath.
    const url = new URL(c.req.url);
    const pathParts = url.pathname.match(
      /\/api\/v1\/repos\/([^/]+)\/files(?:\/(.+))?/
    );

    if (!pathParts) {
      throw new ValidationError("Invalid file path");
    }

    const repoId = pathParts[1];
    const filepath = pathParts[2];
    const branch = c.req.query("branch") ?? "main";

    const repo = await getRepo(repoId);

    if (!filepath) {
      // List files
      const files = await gitService.listFiles(repo.gitPath, branch);
      return c.json({ files });
    }

    // Get file contents
    const content = await gitService.getFileContents(
      repo.gitPath,
      filepath,
      branch
    );

    return c.json({ path: filepath, content });
  });

  return app;
}
