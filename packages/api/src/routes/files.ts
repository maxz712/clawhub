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

// Helper to load repo by ID (shared across route creators)
async function getRepo(db: Database, repoId: string) {
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

/**
 * Original file routes mounted at /repos/:id/files
 * GET /api/v1/repos/:id/files — list files (backward compat)
 * GET /api/v1/repos/:id/files/* — get file content (backward compat)
 * GET /api/v1/repos/:id/files/:branch — batch get files with ?paths= query param
 */
export function createFileRoutes(db: Database, gitService: GitService) {
  const app = new Hono();

  // GET /:branch with ?paths= query param — batch file content
  // Must be before the wildcard handler to match first
  app.get("/:branch", async (c) => {
    const url = new URL(c.req.url);
    const pathsParam = c.req.query("paths");

    // Extract repo ID from the parent mount path
    const pathParts = url.pathname.match(
      /\/api\/v1\/repos\/([^/]+)\/files/
    );
    if (!pathParts) {
      throw new ValidationError("Invalid file path");
    }
    const repoId = pathParts[1];
    const branch = c.req.param("branch");

    if (pathsParam) {
      // Batch mode: return contents of specified files
      const repo = await getRepo(db, repoId);
      const filePaths = pathsParam.split(",").map((p) => p.trim()).filter(Boolean);

      const results: { path: string; content: string }[] = [];
      for (const fp of filePaths) {
        try {
          const content = await gitService.getFileContents(repo.gitPath, fp, branch);
          results.push({ path: fp, content });
        } catch {
          // Skip files that can't be read
          results.push({ path: fp, content: "" });
        }
      }

      return c.json({ files: results });
    }

    // No paths param — list files for this branch
    const repo = await getRepo(db, repoId);
    const filePaths = await gitService.listFiles(repo.gitPath, branch);
    const files = buildFileTree(filePaths);
    return c.json({ files });
  });

  // GET /* — backward compatible wildcard handler
  app.get("/*", async (c) => {
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

    const repo = await getRepo(db, repoId);

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

/**
 * Tree routes mounted at /repos/:id/tree
 * GET /api/v1/repos/:id/tree/:branch — list files/dirs at branch
 * GET /api/v1/repos/:id/tree/:branch/* — list files/dirs at path within branch
 */
export function createTreeRoutes(db: Database, gitService: GitService) {
  const app = new Hono();

  app.get("/:branch", async (c) => {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.match(
      /\/api\/v1\/repos\/([^/]+)\/tree/
    );
    if (!pathParts) {
      throw new ValidationError("Invalid tree path");
    }
    const repoId = pathParts[1];
    const branch = c.req.param("branch");

    const repo = await getRepo(db, repoId);
    const filePaths = await gitService.listFiles(repo.gitPath, branch);
    const files = buildFileTree(filePaths);
    return c.json({ files });
  });

  app.get("/:branch/*", async (c) => {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.match(
      /\/api\/v1\/repos\/([^/]+)\/tree\/([^/]+)\/(.+)/
    );
    if (!pathParts) {
      throw new ValidationError("Invalid tree path");
    }
    const repoId = pathParts[1];
    const branch = pathParts[2];
    const dirPath = pathParts[3];

    const repo = await getRepo(db, repoId);
    const allFiles = await gitService.listFiles(repo.gitPath, branch);
    // Filter to only files under the specified directory
    const filteredFiles = allFiles.filter(
      (f) => f === dirPath || f.startsWith(dirPath + "/")
    );
    const files = buildFileTree(filteredFiles);
    return c.json({ files });
  });

  return app;
}

/**
 * Single file content route mounted at /repos/:id/file
 * GET /api/v1/repos/:id/file/:branch/* — get single file content
 */
export function createSingleFileRoute(db: Database, gitService: GitService) {
  const app = new Hono();

  app.get("/:branch/*", async (c) => {
    const url = new URL(c.req.url);
    const pathParts = url.pathname.match(
      /\/api\/v1\/repos\/([^/]+)\/file\/([^/]+)\/(.+)/
    );
    if (!pathParts) {
      throw new ValidationError("Invalid file path");
    }
    const repoId = pathParts[1];
    const branch = pathParts[2];
    const filepath = pathParts[3];

    const repo = await getRepo(db, repoId);
    const content = await gitService.getFileContents(
      repo.gitPath,
      filepath,
      branch
    );

    return c.json({ path: filepath, content });
  });

  return app;
}
