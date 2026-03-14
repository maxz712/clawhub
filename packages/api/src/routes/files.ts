import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { repositories } from "../models/schema.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";

interface FileTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeEntry[];
}

function buildFileTree(paths: string[]): FileTreeEntry[] {
  const root: FileTreeEntry[] = [];

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const partialPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      let existing = current.find((e) => e.path === partialPath);
      if (!existing) {
        existing = {
          name,
          path: partialPath,
          type: isFile ? "file" : "directory",
          ...(isFile ? {} : { children: [] }),
        };
        current.push(existing);
      }
      if (!isFile) {
        current = existing.children!;
      }
    }
  }

  return root;
}

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
      const filePaths = await gitService.listFiles(repo.gitPath, branch);
      const files = buildFileTree(filePaths);
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
