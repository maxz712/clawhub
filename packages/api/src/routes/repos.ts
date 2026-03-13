import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  repositories,
  changes,
  auditEvents,
  agents,
  permissionRules,
} from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
} from "../services/errors.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { ChangeService } from "../services/changes.js";

export function createRepoRoutes(
  db: Database,
  gitService: GitService,
  changeService: ChangeService
) {
  const app = new Hono();

  // POST /api/v1/repos — Create a repository
  app.post("/", async (c) => {
    const payload = c.get("tokenPayload");
    const body = await c.req.json();
    const { name, description, default_branch } = body;

    if (!name) {
      throw new ValidationError("name is required");
    }

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

  // POST /api/v1/repos/:id/changes — Submit a change (with permission + intent processing)
  app.post("/:id/changes", async (c) => {
    const repoId = c.req.param("id");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    const { intent, description, branch, files, risk_assessment } = body;

    if (!intent || !branch || !files || !Array.isArray(files)) {
      throw new ValidationError("intent, branch, and files are required");
    }

    const agentId = payload.type === "agent" ? payload.sub : null;

    const change = await changeService.processSubmission({
      repoId,
      agentId,
      intent,
      description,
      branch,
      files,
      riskAssessment: risk_assessment,
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
          semantic_diff: change.semanticDiff,
          created_at: change.createdAt,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:id/changes — List changes for a repo
  app.get("/:id/changes", async (c) => {
    const repoId = c.req.param("id");

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

  // POST /api/v1/repos/:id/changes/:changeId/approve
  app.post("/:id/changes/:changeId/approve", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can approve changes");
    }

    const updated = await changeService.approveChange(
      changeId,
      repoId,
      payload.sub
    );

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        reviewed_at: updated.reviewedAt,
        reviewed_by: updated.reviewedBy,
      },
    });
  });

  // POST /api/v1/repos/:id/changes/:changeId/reject
  app.post("/:id/changes/:changeId/reject", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can reject changes");
    }

    const body = await c.req.json().catch(() => ({}));

    const updated = await changeService.rejectChange(
      changeId,
      repoId,
      payload.sub,
      body.reason
    );

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        reviewed_at: updated.reviewedAt,
        reviewed_by: updated.reviewedBy,
      },
    });
  });

  // POST /api/v1/repos/:id/changes/:changeId/merge
  app.post("/:id/changes/:changeId/merge", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can merge changes");
    }

    const updated = await changeService.mergeChange(
      changeId,
      repoId,
      payload.sub
    );

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        reviewed_at: updated.reviewedAt,
        reviewed_by: updated.reviewedBy,
      },
    });
  });

  // POST /api/v1/repos/:id/changes/:changeId/rollback
  app.post("/:id/changes/:changeId/rollback", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can rollback changes");
    }

    const updated = await changeService.rollbackChange(
      changeId,
      repoId,
      payload.sub
    );

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        reviewed_at: updated.reviewedAt,
        reviewed_by: updated.reviewedBy,
      },
    });
  });

  // --- Permission Rule Routes ---

  // POST /api/v1/repos/:id/permissions — Create a permission rule
  app.post("/:id/permissions", async (c) => {
    const repoId = c.req.param("id");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    if (payload.type !== "user") {
      throw new ValidationError("Only users can manage permission rules");
    }

    const { agent_id, rule_type, pattern, conditions } = body;

    if (!rule_type || !pattern) {
      throw new ValidationError("rule_type and pattern are required");
    }

    const validTypes = ["allow_path", "deny_path", "require_approval", "auto_merge"];
    if (!validTypes.includes(rule_type)) {
      throw new ValidationError(
        `Invalid rule_type. Must be one of: ${validTypes.join(", ")}`
      );
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const [rule] = await db
      .insert(permissionRules)
      .values({
        repoId,
        agentId: agent_id ?? null,
        ruleType: rule_type,
        pattern,
        conditions: conditions ?? null,
      })
      .returning();

    await db.insert(auditEvents).values({
      repoId,
      action: "permission_rule_created",
      metadata: { ruleId: rule.id, ruleType: rule_type, pattern },
    });

    return c.json(
      {
        permission_rule: {
          id: rule.id,
          repo_id: rule.repoId,
          agent_id: rule.agentId,
          rule_type: rule.ruleType,
          pattern: rule.pattern,
          conditions: rule.conditions,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:id/permissions — List permission rules
  app.get("/:id/permissions", async (c) => {
    const repoId = c.req.param("id");

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const rules = await db
      .select()
      .from(permissionRules)
      .where(eq(permissionRules.repoId, repoId));

    return c.json({
      permission_rules: rules.map((r) => ({
        id: r.id,
        repo_id: r.repoId,
        agent_id: r.agentId,
        rule_type: r.ruleType,
        pattern: r.pattern,
        conditions: r.conditions,
      })),
    });
  });

  // DELETE /api/v1/repos/:id/permissions/:ruleId — Delete a permission rule
  app.delete("/:id/permissions/:ruleId", async (c) => {
    const repoId = c.req.param("id");
    const ruleId = c.req.param("ruleId");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can manage permission rules");
    }

    const [rule] = await db
      .select()
      .from(permissionRules)
      .where(
        and(
          eq(permissionRules.id, ruleId),
          eq(permissionRules.repoId, repoId)
        )
      )
      .limit(1);

    if (!rule) {
      throw new NotFoundError("PermissionRule", ruleId);
    }

    await db
      .delete(permissionRules)
      .where(eq(permissionRules.id, ruleId));

    await db.insert(auditEvents).values({
      repoId,
      action: "permission_rule_deleted",
      metadata: { ruleId },
    });

    return c.json({ deleted: true });
  });

  return app;
}
