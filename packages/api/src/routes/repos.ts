import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { rm } from "node:fs/promises";
import {
  repositories,
  changes,
  auditEvents,
  agents,
  users,
  permissionRules,
  reviews,
  humanSummaries,
} from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
  AuthError,
} from "../services/errors.js";
import { canMerge, DEFAULT_MERGE_POLICY } from "../services/merge-policy.js";
import type { MergePolicy } from "../services/merge-policy.js";
import { buildDecisionView } from "../services/decision-view.js";
import type { Database } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { ChangeService } from "../services/changes.js";
import type { TokenPayload } from "../services/auth.js";

/**
 * Check if the authenticated user/agent is the owner of this repo.
 * - User owners: payload.sub === repo.ownerId
 * - Agent owners: payload.sub === repo.ownerAgentId (for unclaimed agent-owned repos)
 * - Claimed agent: agent's ownerId matches repo.ownerId
 */
function isRepoOwner(
  repo: typeof repositories.$inferSelect,
  payload: TokenPayload
): boolean {
  if (payload.type === "user") {
    return repo.ownerId === payload.sub;
  }
  // Agent: direct owner of the repo
  if (repo.ownerAgentId === payload.sub) {
    return true;
  }
  return false;
}

// --- File tree helper ---

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

import { resolveRepoByOwnerAndName } from "../services/repo-resolver.js";

export function createRepoRoutes(
  db: Database,
  gitService: GitService,
  changeService: ChangeService
) {
  const app = new Hono();

  // ============================================================
  // Repo info & management
  // ============================================================

  // GET /api/v1/repos/:owner/:repo — Repo info + policies
  app.get("/:owner/:repo", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    return c.json({
      repository: {
        id: repo.id,
        name: repo.name,
        owner_id: repo.ownerId,
        owner_agent_id: repo.ownerAgentId,
        created_by: repo.createdBy,
        git_path: repo.gitPath,
        description: repo.description,
        default_branch: repo.defaultBranch,
        is_public: repo.isPublic,
        merge_policy: repo.mergePolicy,
        reviewer_config: repo.reviewerConfig,
        escalation_policy: repo.escalationPolicy,
        human_summary_config: repo.humanSummaryConfig,
        created_at: repo.createdAt,
      },
    });
  });

  // GET /api/v1/repos/:owner/:repo/tree/:branch — File listing
  app.get("/:owner/:repo/tree/:branch", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const filePaths = await gitService.listFiles(result.repo.gitPath, branch);
    const files = buildFileTree(filePaths);
    return c.json({ files });
  });

  // GET /api/v1/repos/:owner/:repo/file/:branch/* — File content
  app.get("/:owner/:repo/file/:branch/*", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;

    // Extract the file path from the wildcard portion of the URL
    const url = new URL(c.req.url);
    const prefix = `/api/v1/repos/${owner}/${repoName}/file/${branch}/`;
    const filepath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length);

    if (!filepath) {
      throw new ValidationError("File path is required");
    }

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const content = await gitService.getFileContents(result.repo.gitPath, filepath, branch);
    return c.json({ path: filepath, content });
  });

  // PUT /api/v1/repos/:owner/:repo/merge-policy — Update merge policy
  app.put("/:owner/:repo/merge-policy", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("Only the repository owner can update merge policy");
    }

    const body = await c.req.json();
    const newPolicy: MergePolicy = {
      min_approvals: body.min_approvals ?? 1,
      agent_approvals_sufficient: body.agent_approvals_sufficient ?? true,
      self_review_allowed: body.self_review_allowed ?? false,
      escalation_overrides_merge: body.escalation_overrides_merge ?? true,
      require_human_approval_for: body.require_human_approval_for,
      auto_merge_on_push: body.auto_merge_on_push,
      path_overrides: body.path_overrides,
    };

    const [updated] = await db
      .update(repositories)
      .set({ mergePolicy: newPolicy })
      .where(eq(repositories.id, repo.id))
      .returning();

    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "merge_policy_updated",
      metadata: { policy: newPolicy, updatedBy: payload.sub },
    });

    return c.json({ merge_policy: updated.mergePolicy });
  });

  // PUT /api/v1/repos/:owner/:repo/reviewer-config — Update reviewer config
  app.put("/:owner/:repo/reviewer-config", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("Only the repository owner can update reviewer config");
    }

    const body = await c.req.json();

    const [updated] = await db
      .update(repositories)
      .set({ reviewerConfig: body })
      .where(eq(repositories.id, repo.id))
      .returning();

    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "reviewer_config_updated",
      metadata: { config: body, updatedBy: payload.sub },
    });

    return c.json({ reviewer_config: updated.reviewerConfig });
  });

  // PUT /api/v1/repos/:owner/:repo/escalation-policy — Update escalation policy
  app.put("/:owner/:repo/escalation-policy", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("Only the repository owner can update escalation policy");
    }

    const body = await c.req.json();

    const [updated] = await db
      .update(repositories)
      .set({ escalationPolicy: body })
      .where(eq(repositories.id, repo.id))
      .returning();

    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "escalation_policy_updated",
      metadata: { policy: body, updatedBy: payload.sub },
    });

    return c.json({ escalation_policy: updated.escalationPolicy });
  });

  // PUT /api/v1/repos/:owner/:repo/summary-config — Update human summary generation settings
  app.put("/:owner/:repo/summary-config", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("Only the repository owner can update summary config");
    }

    const body = await c.req.json();

    const config = {
      summary_triggers: body.summary_triggers ?? ["escalation"],
      summary_on_all_changes: body.summary_on_all_changes ?? false,
    };

    const [updated] = await db
      .update(repositories)
      .set({ humanSummaryConfig: config })
      .where(eq(repositories.id, repo.id))
      .returning();

    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "summary_config_updated",
      metadata: { config, updatedBy: payload.sub },
    });

    return c.json({ human_summary_config: updated.humanSummaryConfig });
  });

  // PUT /api/v1/repos/:owner/:repo/permissions — Edit permission rules (bulk replace)
  app.put("/:owner/:repo/permissions", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("Only the repository owner can manage permissions");
    }

    const body = await c.req.json();
    const rules = body.rules;

    if (!Array.isArray(rules)) {
      throw new ValidationError("rules must be an array");
    }

    const validTypes = ["allow_path", "deny_path", "allow_review", "deny_review"];

    for (const rule of rules) {
      if (!rule.rule_type || !rule.pattern) {
        throw new ValidationError("Each rule must have rule_type and pattern");
      }
      if (!validTypes.includes(rule.rule_type)) {
        throw new ValidationError(
          `Invalid rule_type '${rule.rule_type}'. Must be one of: ${validTypes.join(", ")}`
        );
      }
    }

    // Delete existing rules for this repo, then insert new ones
    await db.delete(permissionRules).where(eq(permissionRules.repoId, repo.id));

    const inserted = [];
    for (const rule of rules) {
      const [created] = await db
        .insert(permissionRules)
        .values({
          repoId: repo.id,
          agentId: rule.agent_id ?? null,
          ruleType: rule.rule_type,
          pattern: rule.pattern,
          conditions: rule.conditions ?? null,
        })
        .returning();
      inserted.push(created);
    }

    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "permissions_updated",
      metadata: { ruleCount: inserted.length, updatedBy: payload.sub },
    });

    return c.json({
      permission_rules: inserted.map((r) => ({
        id: r.id,
        repo_id: r.repoId,
        agent_id: r.agentId,
        rule_type: r.ruleType,
        pattern: r.pattern,
        conditions: r.conditions,
      })),
    });
  });

  // DELETE /api/v1/repos/:owner/:repo — Delete a repository
  app.delete("/:owner/:repo", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const { repo } = result;

    if (!isRepoOwner(repo, payload)) {
      throw new AuthError("You do not own this repository");
    }

    // Delete git directory
    const repoPath = gitService.getRepoPath(repo.gitPath);
    await rm(repoPath, { recursive: true, force: true });

    // Delete from database
    await db.delete(repositories).where(eq(repositories.id, repo.id));

    // Log audit event
    await db.insert(auditEvents).values({
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      action: "repo_deleted",
      metadata: { repoId: repo.id, name: repo.name },
    });

    return c.json({ deleted: true });
  });

  // GET /api/v1/repos/:owner/:repo/commits/:branch — Get commit history
  app.get("/:owner/:repo/commits/:branch", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const branch = c.req.param("branch")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const commits = await gitService.getCommitLog(result.repo.gitPath, branch);
    return c.json({ commits });
  });

  // ============================================================
  // Changes
  // ============================================================

  // GET /api/v1/repos/:owner/:repo/changes — List changes for a repo
  app.get("/:owner/:repo/changes", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const repoChanges = await db
      .select()
      .from(changes)
      .where(eq(changes.repoId, result.repo.id))
      .orderBy(changes.createdAt);

    return c.json({
      changes: repoChanges.map((ch) => ({
        id: ch.id,
        repo_id: ch.repoId,
        author_id: ch.authorId,
        author_type: ch.authorType,
        branch: ch.branch,
        intent: ch.intent,
        status: ch.status,
        risk_level: ch.riskLevel,
        scope: ch.scope,
        decisions: ch.decisions,
        review_focus: ch.reviewFocus,
        review_comments: ch.reviewComments,
        refs: ch.refs,
        commit_count: ch.commitCount,
        has_conflicts: ch.hasConflicts,
        escalated: ch.escalated,
        escalation_reason: ch.escalationReason,
        human_summary_id: ch.humanSummaryId,
        created_at: ch.createdAt,
        updated_at: ch.updatedAt,
      })),
    });
  });

  // GET /api/v1/repos/:owner/:repo/changes/:id — Change detail + reviews
  app.get("/:owner/:repo/changes/:id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const changeId = c.req.param("id")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, result.repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const changeReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId));

    return c.json({
      change: {
        id: change.id,
        repo_id: change.repoId,
        author_id: change.authorId,
        author_type: change.authorType,
        branch: change.branch,
        intent: change.intent,
        status: change.status,
        risk_level: change.riskLevel,
        scope: change.scope,
        decisions: change.decisions,
        review_focus: change.reviewFocus,
        review_comments: change.reviewComments,
        refs: change.refs,
        commit_count: change.commitCount,
        has_conflicts: change.hasConflicts,
        escalated: change.escalated,
        escalation_reason: change.escalationReason,
        human_summary_id: change.humanSummaryId,
        created_at: change.createdAt,
        updated_at: change.updatedAt,
      },
      reviews: changeReviews.map((r) => ({
        id: r.id,
        reviewer_id: r.reviewerId,
        reviewer_type: r.reviewerType,
        verdict: r.verdict,
        summary: r.summary,
        decisions: r.decisions,
        uncertainty: r.uncertainty,
        verified_scope: r.verifiedScope,
        unverified_scope: r.unverifiedScope,
        comments: r.comments,
        created_at: r.createdAt,
      })),
    });
  });

  // GET /api/v1/repos/:owner/:repo/changes/:id/decisions — Decision view
  app.get("/:owner/:repo/changes/:id/decisions", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const changeId = c.req.param("id")!;

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, result.repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const changeReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId));

    // Build agent name lookup for reviewer display names
    const reviewerIds = changeReviews.map((r) => r.reviewerId);
    const agentNames = new Map<string, string>();

    if (reviewerIds.length > 0) {
      const agentRows = await db.select().from(agents);
      for (const a of agentRows) {
        agentNames.set(a.id, a.name);
      }
      const userRows = await db.select().from(users);
      for (const u of userRows) {
        agentNames.set(u.id, u.email.split("@")[0]);
      }
    }

    // Fetch human summary if one exists
    let humanSummary = null;
    if (change.humanSummaryId) {
      const [hs] = await db
        .select()
        .from(humanSummaries)
        .where(eq(humanSummaries.id, change.humanSummaryId))
        .limit(1);
      humanSummary = hs ?? null;
    }

    const decisionView = buildDecisionView(change, changeReviews, agentNames, humanSummary);
    return c.json(decisionView);
  });

  // POST /api/v1/repos/:owner/:repo/changes/:id/merge — Merge
  app.post("/:owner/:repo/changes/:id/merge", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const changeId = c.req.param("id")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, result.repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const actorType = payload.type === "agent" ? "agent" : "human";
    await changeService.mergeChange(changeId, payload.sub, actorType);

    // Fetch updated change
    const [updated] = await db
      .select()
      .from(changes)
      .where(eq(changes.id, changeId))
      .limit(1);

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        updated_at: updated.updatedAt,
      },
    });
  });

  // POST /api/v1/repos/:owner/:repo/changes/:id/rollback — Rollback
  app.post("/:owner/:repo/changes/:id/rollback", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const changeId = c.req.param("id")!;
    const payload = c.get("tokenPayload");

    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }

    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, result.repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const rollbackActorType = payload.type === "agent" ? "agent" : "human";
    await changeService.rollbackChange(changeId, payload.sub, rollbackActorType);

    // Fetch updated change
    const [updated] = await db
      .select()
      .from(changes)
      .where(eq(changes.id, changeId))
      .limit(1);

    return c.json({
      change: {
        id: updated.id,
        status: updated.status,
        updated_at: updated.updatedAt,
      },
    });
  });

  return app;
}
