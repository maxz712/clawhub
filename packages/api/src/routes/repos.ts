import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { repositories, changes, auditEvents, agents } from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
} from "../services/errors.js";
import type { Database } from "../models/db.js";
import type { GitService, FileChange } from "../services/git.js";

export function createRepoRoutes(db: Database, gitService: GitService) {
  const app = new Hono();

  // POST /api/v1/repos — Create a repository
  app.post("/", async (c) => {
    const payload = c.get("tokenPayload");
    const body = await c.req.json();
    const { name, description, default_branch } = body;

    if (!name) {
      throw new ValidationError("name is required");
    }

    // Determine owner: for agents, look up their owner_id; for users, use sub directly
    let ownerId: string;
    if (payload.type === "agent") {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, payload.sub))
        .limit(1);
      if (!agent) {
        throw new NotFoundError("Agent", payload.sub);
      }
      ownerId = agent.ownerId;
    } else {
      ownerId = payload.sub;
    }

    const gitPath = `${ownerId}/${name}.git`;

    // Init bare git repo
    await gitService.initBareRepo(gitPath);

    const [repo] = await db
      .insert(repositories)
      .values({
        name,
        ownerId,
        gitPath,
        description: description ?? null,
        defaultBranch: default_branch ?? "main",
      })
      .returning();

    // Audit event
    await db.insert(auditEvents).values({
      repoId: repo.id,
      agentId: payload.type === "agent" ? payload.sub : null,
      action: "repo_created",
      metadata: { name },
    });

    return c.json(
      {
        repository: {
          id: repo.id,
          name: repo.name,
          owner_id: repo.ownerId,
          git_path: repo.gitPath,
          description: repo.description,
          default_branch: repo.defaultBranch,
          created_at: repo.createdAt,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:id — Get repo info
  app.get("/:id", async (c) => {
    const repoId = c.req.param("id");

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    return c.json({
      repository: {
        id: repo.id,
        name: repo.name,
        owner_id: repo.ownerId,
        git_path: repo.gitPath,
        description: repo.description,
        default_branch: repo.defaultBranch,
        created_at: repo.createdAt,
      },
    });
  });

  // POST /api/v1/repos/:id/changes — Submit a change
  app.post("/:id/changes", async (c) => {
    const repoId = c.req.param("id");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    const { intent, description, branch, files, risk_assessment } = body;

    if (!intent || !branch || !files || !Array.isArray(files)) {
      throw new ValidationError(
        "intent, branch, and files are required"
      );
    }

    // Verify repo exists
    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const agentId = payload.type === "agent" ? payload.sub : null;
    const riskLevel = risk_assessment?.level ?? "low";

    // Create branch in git
    await gitService.createBranch(repo.gitPath, branch, repo.defaultBranch);

    // Apply file changes
    const fileChanges: FileChange[] = files.map((f: any) => ({
      path: f.path,
      action: f.action ?? "create",
      content: f.content,
      diff: f.diff,
      explanation: f.explanation,
    }));

    await gitService.applyDiff(
      repo.gitPath,
      branch,
      fileChanges,
      intent
    );

    // Build diff summary
    const diffSummary = {
      files_changed: files.length,
      files: files.map((f: any) => ({
        path: f.path,
        action: f.action ?? "create",
      })),
    };

    // Store the change
    const [change] = await db
      .insert(changes)
      .values({
        repoId,
        agentId,
        intent,
        description: description ?? null,
        status: "pending",
        riskLevel,
        branch,
        diffSummary,
        semanticDiff: risk_assessment
          ? { reasoning: risk_assessment.reasoning }
          : null,
      })
      .returning();

    // Audit event
    await db.insert(auditEvents).values({
      repoId,
      agentId,
      action: "change_created",
      metadata: { changeId: change.id, intent, riskLevel },
    });

    return c.json(
      {
        change: {
          id: change.id,
          repo_id: change.repoId,
          agent_id: change.agentId,
          intent: change.intent,
          description: change.description,
          status: change.status,
          risk_level: change.riskLevel,
          branch: change.branch,
          diff_summary: change.diffSummary,
          created_at: change.createdAt,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:id/changes — List changes for a repo
  app.get("/:id/changes", async (c) => {
    const repoId = c.req.param("id");

    // Verify repo exists
    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const repoChanges = await db
      .select()
      .from(changes)
      .where(eq(changes.repoId, repoId))
      .orderBy(changes.createdAt);

    return c.json({
      changes: repoChanges.map((ch) => ({
        id: ch.id,
        repo_id: ch.repoId,
        agent_id: ch.agentId,
        intent: ch.intent,
        description: ch.description,
        status: ch.status,
        risk_level: ch.riskLevel,
        branch: ch.branch,
        diff_summary: ch.diffSummary,
        created_at: ch.createdAt,
        reviewed_at: ch.reviewedAt,
        reviewed_by: ch.reviewedBy,
      })),
    });
  });

  // GET /api/v1/repos/:id/changes/:changeId — Get change status
  app.get("/:id/changes/:changeId", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    return c.json({
      change: {
        id: change.id,
        repo_id: change.repoId,
        agent_id: change.agentId,
        intent: change.intent,
        description: change.description,
        status: change.status,
        risk_level: change.riskLevel,
        branch: change.branch,
        diff_summary: change.diffSummary,
        semantic_diff: change.semanticDiff,
        created_at: change.createdAt,
        reviewed_at: change.reviewedAt,
        reviewed_by: change.reviewedBy,
      },
    });
  });

  return app;
}
