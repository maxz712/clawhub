import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { repositories, users, auditEvents } from "../models/schema.js";
import { NotFoundError, AuthError } from "../services/errors.js";
import { proxyToGitBackend } from "../services/git-backend.js";
import { authenticateGitRequest } from "../middleware/auth.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { EventBus } from "../services/events.js";
import type { Context } from "hono";

const GIT_PROJECT_ROOT =
  process.env.GIT_REPOS_BASE_PATH || "./data/repos";

/**
 * Resolve a repository by owner identifier and repo name.
 * Owner can be matched by email prefix (part before @) or by user ID.
 */
async function resolveRepo(db: Database, owner: string, name: string) {
  // Try to find user by email prefix first, then by ID
  const allMatches = await db
    .select({
      repo: repositories,
      user: users,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.name, name));

  // Match by email prefix (e.g., "alice" matches "alice@example.com")
  let match = allMatches.find((row) => {
    const emailPrefix = row.user.email.split("@")[0];
    return emailPrefix === owner;
  });

  // Fall back to matching by owner ID
  if (!match) {
    match = allMatches.find((row) => row.user.id === owner);
  }

  return match ?? null;
}

export function createGitHttpRoutes(
  db: Database,
  gitService: GitService,
  eventBus: EventBus
): Hono {
  const app = new Hono();

  // GET /:owner/:repo.git/info/refs — Git ref discovery (smart HTTP)
  app.get("/:owner/:repo.git/info/refs", async (c: Context) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const service = c.req.query("service");

    if (!service || !["git-upload-pack", "git-receive-pack"].includes(service)) {
      return c.text("Invalid service", 400);
    }

    const result = await resolveRepo(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    // Auth check: private repos require authentication
    // git-receive-pack (push) always requires authentication
    const tokenPayload = await authenticateGitRequest(c);

    if (service === "git-receive-pack" && !tokenPayload) {
      throw new AuthError("Authentication required for push operations");
    }

    if (!repo.isPublic && !tokenPayload) {
      throw new AuthError("Authentication required for private repositories");
    }

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}`,
      QUERY_STRING: `service=${service}`,
      REQUEST_METHOD: "GET",
    };

    const response = await proxyToGitBackend(env);
    return response;
  });

  // POST /:owner/:repo.git/git-upload-pack — Clone/fetch
  app.post("/:owner/:repo.git/git-upload-pack", async (c: Context) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");

    const result = await resolveRepo(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    // Auth check for private repos
    const tokenPayload = await authenticateGitRequest(c);

    if (!repo.isPublic && !tokenPayload) {
      throw new AuthError("Authentication required for private repositories");
    }

    const body = await c.req.arrayBuffer();

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}`,
      REQUEST_METHOD: "POST",
      CONTENT_TYPE: c.req.header("content-type") || "application/x-git-upload-pack-request",
    };

    const response = await proxyToGitBackend(env, body);

    // Audit: log clone/fetch
    if (tokenPayload) {
      await db.insert(auditEvents).values({
        repoId: repo.id,
        agentId: tokenPayload.type === "agent" ? tokenPayload.sub : undefined,
        action: "git.fetch",
        metadata: {
          userId: tokenPayload.sub,
          userType: tokenPayload.type,
        },
      });
    }

    return response;
  });

  // POST /:owner/:repo.git/git-receive-pack — Push
  app.post("/:owner/:repo.git/git-receive-pack", async (c: Context) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");

    const result = await resolveRepo(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    // Push always requires authentication
    const tokenPayload = await authenticateGitRequest(c);

    if (!tokenPayload) {
      throw new AuthError("Authentication required for push operations");
    }

    const body = await c.req.arrayBuffer();

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}`,
      REQUEST_METHOD: "POST",
      CONTENT_TYPE: c.req.header("content-type") || "application/x-git-receive-pack-request",
    };

    const response = await proxyToGitBackend(env, body);

    // Audit: log push
    await db.insert(auditEvents).values({
      repoId: repo.id,
      agentId: tokenPayload.type === "agent" ? tokenPayload.sub : undefined,
      action: "git.push",
      metadata: {
        userId: tokenPayload.sub,
        userType: tokenPayload.type,
      },
    });

    // Fire async processing for incoming push
    // (processIncomingPush service doesn't exist yet — log for now)
    console.log(
      `[git-receive-pack] Push received for ${owner}/${repoName} by ${tokenPayload.type}:${tokenPayload.sub}`
    );

    // Emit event for real-time dashboard
    await eventBus.emit({
      type: "git.push",
      repoId: repo.id,
      agentId: tokenPayload.type === "agent" ? tokenPayload.sub : undefined,
      data: {
        owner,
        repo: repoName,
        userId: tokenPayload.sub,
        userType: tokenPayload.type,
      },
      timestamp: new Date().toISOString(),
    });

    return response;
  });

  return app;
}
