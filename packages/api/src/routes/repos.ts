import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { rm } from "node:fs/promises";
import {
  repositories,
  changes,
  auditEvents,
  agents,
  permissionRules,
  reviews,
} from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
  AuthError,
} from "../services/errors.js";
import { canMerge, DEFAULT_MERGE_POLICY } from "../services/merge-policy.js";
import type { MergePolicy } from "../services/merge-policy.js";
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
          created_by: repo.createdBy,
          git_path: repo.gitPath,
          description: repo.description,
          default_branch: repo.defaultBranch,
          is_public: repo.isPublic,
          merge_policy: repo.mergePolicy,
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
        created_by: repo.createdBy,
        git_path: repo.gitPath,
        description: repo.description,
        default_branch: repo.defaultBranch,
        is_public: repo.isPublic,
        merge_policy: repo.mergePolicy,
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
          has_conflicts: change.hasConflicts,
          source: change.source,
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
        scope: ch.scope,
        review_focus: ch.reviewFocus,
        review_comments: ch.reviewComments,
        refs: ch.refs,
        commit_count: ch.commitCount,
        branch: ch.branch,
        has_conflicts: ch.hasConflicts,
        source: ch.source,
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
        scope: change.scope,
        review_focus: change.reviewFocus,
        review_comments: change.reviewComments,
        refs: change.refs,
        commit_count: change.commitCount,
        branch: change.branch,
        has_conflicts: change.hasConflicts,
        source: change.source,
        diff_summary: change.diffSummary,
        semantic_diff: change.semanticDiff,
        created_at: change.createdAt,
        reviewed_at: change.reviewedAt,
        reviewed_by: change.reviewedBy,
      },
    });
  });

  // GET /api/v1/repos/:id/changes/:changeId/focused — Focused diff (agent-highlighted sections only)
  app.get("/:id/changes/:changeId/focused", async (c) => {
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

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    // Get the full diff
    let fullDiff = "";
    try {
      fullDiff = await gitService.getDiff(repo.gitPath, repo.defaultBranch, change.branch);
    } catch {
      // May fail if branch no longer exists
    }

    // Extract focused sections from Review-Focus areas and REVIEW: comments
    const focusAreas = (change.reviewFocus as any[]) || [];
    const reviewComments = (change.reviewComments as any[]) || [];

    return c.json({
      change_id: change.id,
      focus_areas: focusAreas,
      review_comments: reviewComments,
      has_focus: focusAreas.length > 0 || reviewComments.length > 0,
      full_diff: fullDiff,
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

    // Check merge policy before merging
    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const policy = (repo.mergePolicy as MergePolicy) || DEFAULT_MERGE_POLICY;
    const changeReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId));

    const evaluation = canMerge(
      policy,
      {
        riskLevel: change.riskLevel,
        scope: change.scope ?? [],
        commitCount: change.commitCount ?? 0,
      },
      changeReviews
    );

    if (!evaluation.allowed) {
      throw new ValidationError(`Merge blocked: ${evaluation.reason}`);
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

  // GET /api/v1/repos/:id/merge-policy — Get merge policy
  app.get("/:id/merge-policy", async (c) => {
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
      merge_policy: repo.mergePolicy || DEFAULT_MERGE_POLICY,
    });
  });

  // PUT /api/v1/repos/:id/merge-policy — Update merge policy
  app.put("/:id/merge-policy", async (c) => {
    const repoId = c.req.param("id");
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new ValidationError("Only users can update merge policy");
    }

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    if (repo.ownerId !== payload.sub) {
      throw new AuthError("Only the repository owner can update merge policy");
    }

    const body = await c.req.json();
    const newPolicy: MergePolicy = {
      require_human_approval: body.require_human_approval ?? true,
      min_approvals: body.min_approvals ?? 1,
      agent_approval_weight: body.agent_approval_weight ?? 0.5,
      auto_merge_rules: body.auto_merge_rules ?? null,
      path_overrides: body.path_overrides ?? undefined,
    };

    const [updated] = await db
      .update(repositories)
      .set({ mergePolicy: newPolicy })
      .where(eq(repositories.id, repoId))
      .returning();

    await db.insert(auditEvents).values({
      repoId,
      action: "merge_policy_updated",
      metadata: { policy: newPolicy, updatedBy: payload.sub },
    });

    return c.json({
      merge_policy: updated.mergePolicy,
    });
  });

  // DELETE /api/v1/repos/:id — Delete a repository
  app.delete("/:id", async (c) => {
    const repoId = c.req.param("id");
    const payload = c.get("tokenPayload");

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    // Verify ownership
    let requesterId: string;
    if (payload.type === "agent") {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, payload.sub))
        .limit(1);
      if (!agent) {
        throw new NotFoundError("Agent", payload.sub);
      }
      requesterId = agent.ownerId;
    } else {
      requesterId = payload.sub;
    }

    if (repo.ownerId !== requesterId) {
      throw new AuthError("You do not own this repository");
    }

    // Delete git directory
    const repoPath = gitService.getRepoPath(repo.gitPath);
    await rm(repoPath, { recursive: true, force: true });

    // Delete from database
    await db.delete(repositories).where(eq(repositories.id, repoId));

    // Log audit event
    await db.insert(auditEvents).values({
      agentId: payload.type === "agent" ? payload.sub : null,
      action: "repo_deleted",
      metadata: { repoId, name: repo.name },
    });

    return c.json({ deleted: true });
  });

  // GET /api/v1/repos/:id/commits/:branch — Get commit history
  app.get("/:id/commits/:branch", async (c) => {
    const repoId = c.req.param("id");
    const branch = c.req.param("branch");

    const [repo] = await db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    const commits = await gitService.getCommitLog(repo.gitPath, branch);
    return c.json({ commits });
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
