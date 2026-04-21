import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { importFromGitHub } from "../services/github-import.js";

export function createMigrationRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/github", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only (repo owner is the agent)");
    const body = await c.req.json().catch(() => ({})) as {
      githubToken?: string;
      sourceOwner?: string;
      sourceRepo?: string;
      targetRepoName?: string;
      includeIssues?: boolean;
      includeComments?: boolean;
      ghHost?: string;
    };
    if (!body.githubToken || !body.sourceOwner || !body.sourceRepo) throw new ValidationError("githubToken + sourceOwner + sourceRepo required");
    const result = await importFromGitHub(db, git, {
      githubToken: body.githubToken,
      sourceOwner: body.sourceOwner,
      sourceRepo: body.sourceRepo,
      targetNamespace: p.name,
      namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      createdByKind: "agent",
      createdById: p.agentId,
      includeIssues: body.includeIssues,
      includeComments: body.includeComments,
      ghHost: body.ghHost,
    });
    return c.json(result);
  });

  return app;
}
