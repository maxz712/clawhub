import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { repositories, users, agents, auditEvents } from "../models/schema.js";
import { NotFoundError, AuthError } from "../services/errors.js";
import { proxyToGitBackend } from "../services/git-backend.js";
import { authenticateGitRequest } from "../middleware/auth.js";
import { resolveOrCreateRepo } from "../services/auto-repo.js";
import { processIncomingPush } from "../services/post-push.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { EventBus } from "../services/events.js";
import type { ChangeRefService } from "../services/change-refs.js";
import type { Context } from "hono";

const GIT_PROJECT_ROOT =
  process.env.GIT_REPOS_BASE_PATH || "./data/repos";

import { resolveRepoByOwnerAndName } from "../services/repo-resolver.js";

function resolveRepo(db: Database, owner: string, name: string) {
  return resolveRepoByOwnerAndName(db, owner, name);
}

export function createGitHttpRoutes(
  db: Database,
  gitService: GitService,
  eventBus: EventBus,
  changeRefService: ChangeRefService
): Hono {
  const app = new Hono();

  // Helper: extract repo name from "repo.git" segment
  function parseRepoParam(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    return raw.endsWith(".git") ? raw.slice(0, -4) : raw;
  }

  // GET /:owner/:repoGit/info/refs — Git ref discovery (smart HTTP)
  app.get("/:owner/:repoGit/info/refs", async (c: Context) => {
    const owner = c.req.param("owner");
    const repoName = parseRepoParam(c.req.param("repoGit"));
    const service = c.req.query("service");

    if (!owner || !repoName) {
      return c.text("Invalid repository path", 400);
    }

    if (!service || !["git-upload-pack", "git-receive-pack"].includes(service)) {
      return c.text("Invalid service", 400);
    }

    // For receive-pack (push), require auth first (return 401 to trigger git credential challenge)
    const tokenPayload = await authenticateGitRequest(c);

    if (service === "git-receive-pack" && !tokenPayload) {
      return c.text("Authentication required", 401, {
        "WWW-Authenticate": 'Basic realm="ClawForge"',
      });
    }

    let result: Awaited<ReturnType<typeof resolveRepo>> = null;
    try {
      result = await resolveRepo(db, owner, repoName);
    } catch (err) {
      console.error(`[git-http] resolveRepo failed for ${owner}/${repoName}:`, err);
    }

    if (!result && service === "git-receive-pack" && tokenPayload) {
      // Auto-create repo on push
      const identity = {
        id: tokenPayload.sub,
        type: tokenPayload.type as "agent" | "user",
      };
      try {
        result = await resolveOrCreateRepo(db, gitService, owner, repoName, identity);
      } catch (err) {
        console.error(`[git-http] resolveOrCreateRepo failed for ${owner}/${repoName}:`, err);
      }
    }

    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!repo.isPublic && !tokenPayload) {
      throw new AuthError("Authentication required for private repositories");
    }

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}/info/refs`,
      QUERY_STRING: `service=${service}`,
      REQUEST_METHOD: "GET",
    };

    const response = await proxyToGitBackend(env);
    return response;
  });

  // POST /:owner/:repo.git/git-upload-pack — Clone/fetch
  app.post("/:owner/:repoGit/git-upload-pack", async (c: Context) => {
    const owner = c.req.param("owner")!;
    const repoName = parseRepoParam(c.req.param("repoGit"))!;

    const result = await resolveRepo(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    const tokenPayload = await authenticateGitRequest(c);

    if (!repo.isPublic && !tokenPayload) {
      throw new AuthError("Authentication required for private repositories");
    }

    const body = await c.req.arrayBuffer();

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}/git-upload-pack`,
      REQUEST_METHOD: "POST",
      CONTENT_TYPE: c.req.header("content-type") || "application/x-git-upload-pack-request",
    };

    const response = await proxyToGitBackend(env, body);

    if (tokenPayload) {
      await db.insert(auditEvents).values({
        repoId: repo.id,
        actorId: tokenPayload.sub,
        actorType: tokenPayload.type === "agent" ? "agent" : "human",
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
  app.post("/:owner/:repoGit/git-receive-pack", async (c: Context) => {
    const owner = c.req.param("owner")!;
    const repoName = parseRepoParam(c.req.param("repoGit"))!;

    const tokenPayload = await authenticateGitRequest(c);

    if (!tokenPayload) {
      throw new AuthError("Authentication required for push operations");
    }

    // Try resolve or auto-create
    let result: Awaited<ReturnType<typeof resolveRepo>> = null;
    try {
      result = await resolveRepo(db, owner, repoName);
    } catch (err) {
      console.error(`[git-http] receive-pack resolveRepo failed for ${owner}/${repoName}:`, err);
    }

    if (!result) {
      const identity = {
        id: tokenPayload.sub,
        type: tokenPayload.type as "agent" | "user",
      };
      try {
        result = await resolveOrCreateRepo(db, gitService, owner, repoName, identity);
      } catch (err) {
        console.error(`[git-http] receive-pack resolveOrCreateRepo failed for ${owner}/${repoName}:`, err);
      }
    }

    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    const body = await c.req.arrayBuffer();

    const env: Record<string, string> = {
      GIT_PROJECT_ROOT,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${repo.gitPath}/git-receive-pack`,
      REQUEST_METHOD: "POST",
      CONTENT_TYPE: c.req.header("content-type") || "application/x-git-receive-pack-request",
    };

    const response = await proxyToGitBackend(env, body);

    // Audit: log push
    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: tokenPayload.sub,
      actorType: tokenPayload.type === "agent" ? "agent" : "human",
      action: "git.push",
      metadata: {
        userId: tokenPayload.sub,
        userType: tokenPayload.type,
      },
    });

    // Fire async post-push processing (detect branches, parse trailers, create Changes)
    const pusherInfo = { id: tokenPayload.sub, type: tokenPayload.type as "agent" | "user" };
    processIncomingPush(
      db,
      gitService,
      eventBus,
      changeRefService,
      {
        id: repo.id,
        gitPath: repo.gitPath,
        defaultBranch: repo.defaultBranch,
        ownerId: repo.ownerId ?? repo.ownerAgentId ?? "",
        mergePolicy: repo.mergePolicy as any,
        reviewerConfig: repo.reviewerConfig as any,
        escalationPolicy: repo.escalationPolicy as any,
      },
      pusherInfo
    ).catch((err) =>
      console.error(`[post-push] Error processing push for ${owner}/${repoName}:`, err)
    );

    // Emit event for real-time dashboard
    await eventBus.emit({
      type: "git.push",
      repoId: repo.id,
      actorId: tokenPayload.sub,
      actorType: tokenPayload.type === "agent" ? "agent" : "human",
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
