import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { agents } from "../models/schema.js";
import { resolveImportOwner } from "../services/namespace.js";
import { importFromGitHub } from "../services/github-import.js";
import { importFromGitLab } from "../services/gitlab-import.js";
import { importFromBitbucket } from "../services/bitbucket-import.js";
import { createImportJob, runImportJob, getImportJob } from "../services/import-jobs.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

// Source-import is agent-driven: the imported repo is owned by a USER/ORG
// namespace and the importing agent is granted writer. An optional
// `targetNamespace` picks the owner (the user's own handle by default in the
// clients; the import services authorize the agent against it via
// resolveImportOwner). Imports run in the BACKGROUND — a clone + thousands of
// issues can take a minute — so each POST returns a job id and the client polls
// GET /jobs/:id. Cheap validation + the namespace authorization run synchronously
// so a 400/403/404 still comes back on the POST (not buried in a polled job).
export function createMigrationRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  const audit = getAuditLog(db);

  // Synchronous preflight: caller must be an agent, and the agent must be
  // authorized to create a repo in the target namespace. Returns the agent id.
  async function preflight(c: Context, targetNamespace?: string): Promise<string> {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only — the imported repo is owned by your user/org namespace and the importing agent is granted writer");
    const agent = (await db.select().from(agents).where(eq(agents.id, p.agentId)).limit(1))[0];
    if (!agent) throw new AuthError("agent not found");
    await resolveImportOwner(db, agent, targetNamespace); // throws 403/404 synchronously
    return p.agentId;
  }

  app.post("/github", async c => {
    const body = await c.req.json().catch(() => ({})) as {
      githubToken?: string; sourceOwner?: string; sourceRepo?: string;
      targetNamespace?: string; targetRepoName?: string;
      includeIssues?: boolean; includeComments?: boolean; ghHost?: string;
    };
    if (!body.githubToken || !body.sourceOwner || !body.sourceRepo) throw new ValidationError("githubToken + sourceOwner + sourceRepo required");
    const agentId = await preflight(c, body.targetNamespace);
    const source = `${body.sourceOwner}/${body.sourceRepo}`;
    const ip = ipFromContext(c), userAgent = userAgentFromContext(c);
    const job = await createImportJob(db, { agentId, provider: "github", source, targetNamespace: body.targetNamespace });
    void runImportJob(db, job.id, async () => {
      const result = await importFromGitHub(db, git, {
        githubToken: body.githubToken!, sourceOwner: body.sourceOwner!, sourceRepo: body.sourceRepo!,
        targetNamespace: body.targetNamespace, namespaceId: agentId, targetRepoName: body.targetRepoName,
        createdByKind: "agent", createdById: agentId, includeIssues: body.includeIssues, includeComments: body.includeComments, ghHost: body.ghHost,
      });
      await audit.record({
        repoId: result.repoId, actorKind: "agent", actorId: agentId, action: "repo.imported", category: "repo",
        metadata: { provider: "github", source, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
        ip, userAgent,
      });
      return result;
    });
    return c.json({ jobId: job.id, status: "pending" as const }, 202);
  });

  app.post("/gitlab", async c => {
    const body = await c.req.json().catch(() => ({})) as {
      gitlabToken?: string; projectPath?: string;
      targetNamespace?: string; targetRepoName?: string;
      includeIssues?: boolean; includeComments?: boolean; host?: string;
    };
    if (!body.gitlabToken || !body.projectPath) throw new ValidationError("gitlabToken + projectPath required");
    const agentId = await preflight(c, body.targetNamespace);
    const ip = ipFromContext(c), userAgent = userAgentFromContext(c);
    const job = await createImportJob(db, { agentId, provider: "gitlab", source: body.projectPath, targetNamespace: body.targetNamespace });
    void runImportJob(db, job.id, async () => {
      const result = await importFromGitLab(db, git, {
        gitlabToken: body.gitlabToken!, projectPath: body.projectPath!,
        targetNamespace: body.targetNamespace, namespaceId: agentId, targetRepoName: body.targetRepoName,
        createdByKind: "agent", createdById: agentId, includeIssues: body.includeIssues, includeComments: body.includeComments, host: body.host,
      });
      await audit.record({
        repoId: result.repoId, actorKind: "agent", actorId: agentId, action: "repo.imported", category: "repo",
        metadata: { provider: "gitlab", source: body.projectPath, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
        ip, userAgent,
      });
      return result;
    });
    return c.json({ jobId: job.id, status: "pending" as const }, 202);
  });

  app.post("/bitbucket", async c => {
    const body = await c.req.json().catch(() => ({})) as {
      username?: string; appPassword?: string; workspace?: string; repoSlug?: string;
      targetNamespace?: string; targetRepoName?: string; includeIssues?: boolean;
    };
    if (!body.username || !body.appPassword || !body.workspace || !body.repoSlug) throw new ValidationError("username + appPassword + workspace + repoSlug required");
    const agentId = await preflight(c, body.targetNamespace);
    const source = `${body.workspace}/${body.repoSlug}`;
    const ip = ipFromContext(c), userAgent = userAgentFromContext(c);
    const job = await createImportJob(db, { agentId, provider: "bitbucket", source, targetNamespace: body.targetNamespace });
    void runImportJob(db, job.id, async () => {
      const result = await importFromBitbucket(db, git, {
        username: body.username!, appPassword: body.appPassword!, workspace: body.workspace!, repoSlug: body.repoSlug!,
        targetNamespace: body.targetNamespace, namespaceId: agentId, targetRepoName: body.targetRepoName,
        createdByKind: "agent", createdById: agentId, includeIssues: body.includeIssues,
      });
      await audit.record({
        repoId: result.repoId, actorKind: "agent", actorId: agentId, action: "repo.imported", category: "repo",
        metadata: { provider: "bitbucket", source, targetNamespace: body.targetNamespace ?? null, repoName: result.repoName, namespace: result.namespace, branchesImported: result.branchesImported, issuesImported: result.issuesImported, issuesTruncated: result.issuesTruncated },
        ip, userAgent,
      });
      return result;
    });
    return c.json({ jobId: job.id, status: "pending" as const }, 202);
  });

  // Poll an import job. Scoped to the agent that created it (404 otherwise — no
  // existence leak across agents).
  app.get("/jobs/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    const job = await getImportJob(db, c.req.param("id"));
    if (!job || job.agentId !== p.agentId) throw new NotFoundError("import job");
    return c.json(job);
  });

  return app;
}
