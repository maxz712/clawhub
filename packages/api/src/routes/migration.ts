import { Hono } from "hono";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { importFromGitHub } from "../services/github-import.js";
import { importFromGitLab } from "../services/gitlab-import.js";
import { importFromBitbucket } from "../services/bitbucket-import.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

// Source-import is agent-driven: the imported repo is owned by a USER/ORG
// namespace and the importing agent is granted writer. An optional
// `targetNamespace` picks the owner (the agent's own service-user namespace by
// default); the import services authorize the agent against it (resolveImportOwner).
export function createMigrationRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  const audit = getAuditLog(db);

  app.post("/github", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only — the imported repo is owned by your user/org namespace and the importing agent is granted writer");
    const body = await c.req.json().catch(() => ({})) as {
      githubToken?: string;
      sourceOwner?: string;
      sourceRepo?: string;
      targetNamespace?: string;
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
      targetNamespace: body.targetNamespace,
      namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      createdByKind: "agent",
      createdById: p.agentId,
      includeIssues: body.includeIssues,
      includeComments: body.includeComments,
      ghHost: body.ghHost,
    });
    await audit.record({
      repoId: result.repoId, actorKind: "agent", actorId: p.agentId, action: "repo.imported", category: "repo",
      metadata: { provider: "github", source: `${body.sourceOwner}/${body.sourceRepo}`, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json(result);
  });

  app.post("/gitlab", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only — the imported repo is owned by your user/org namespace and the importing agent is granted writer");
    const body = await c.req.json().catch(() => ({})) as {
      gitlabToken?: string;
      projectPath?: string;
      targetNamespace?: string;
      targetRepoName?: string;
      includeIssues?: boolean;
      includeComments?: boolean;
      host?: string;
    };
    if (!body.gitlabToken || !body.projectPath) throw new ValidationError("gitlabToken + projectPath required");
    const result = await importFromGitLab(db, git, {
      gitlabToken: body.gitlabToken,
      projectPath: body.projectPath,
      targetNamespace: body.targetNamespace,
      namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      createdByKind: "agent",
      createdById: p.agentId,
      includeIssues: body.includeIssues,
      includeComments: body.includeComments,
      host: body.host,
    });
    await audit.record({
      repoId: result.repoId, actorKind: "agent", actorId: p.agentId, action: "repo.imported", category: "repo",
      metadata: { provider: "gitlab", source: body.projectPath, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json(result);
  });

  app.post("/bitbucket", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only — the imported repo is owned by your user/org namespace and the importing agent is granted writer");
    const body = await c.req.json().catch(() => ({})) as {
      username?: string;
      appPassword?: string;
      workspace?: string;
      repoSlug?: string;
      targetNamespace?: string;
      targetRepoName?: string;
      includeIssues?: boolean;
    };
    if (!body.username || !body.appPassword || !body.workspace || !body.repoSlug) throw new ValidationError("username + appPassword + workspace + repoSlug required");
    const result = await importFromBitbucket(db, git, {
      username: body.username,
      appPassword: body.appPassword,
      workspace: body.workspace,
      repoSlug: body.repoSlug,
      targetNamespace: body.targetNamespace,
      namespaceId: p.agentId,
      targetRepoName: body.targetRepoName,
      createdByKind: "agent",
      createdById: p.agentId,
      includeIssues: body.includeIssues,
    });
    await audit.record({
      repoId: result.repoId, actorKind: "agent", actorId: p.agentId, action: "repo.imported", category: "repo",
      metadata: { provider: "bitbucket", source: `${body.workspace}/${body.repoSlug}`, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json(result);
  });

  return app;
}
