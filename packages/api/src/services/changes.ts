import { eq, and } from "drizzle-orm";
import { changes, auditEvents, repositories, permissionRules } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";
import type { IntentEngine } from "./intent.js";
import type { EventBus } from "./events.js";
import { evaluatePermissions } from "./permissions.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
} from "./errors.js";
import type { ChangeRefService } from "./change-refs.js";

export type ChangeStatus = "pending" | "approved" | "rejected" | "merged" | "rolled_back";

// Valid status transitions
const VALID_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["merged", "rejected"],
  rejected: [],
  merged: ["rolled_back"],
  rolled_back: [],
};

export class ChangeService {
  private changeRefService?: ChangeRefService;

  constructor(
    private db: Database,
    private gitService: GitService,
    private intentEngine: IntentEngine,
    private eventBus: EventBus,
    changeRefService?: ChangeRefService
  ) {
    this.changeRefService = changeRefService;
  }

  /**
   * Validate a status transition.
   */
  private validateTransition(from: ChangeStatus, to: ChangeStatus): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed || !allowed.includes(to)) {
      throw new ValidationError(
        `Cannot transition from '${from}' to '${to}'`
      );
    }
  }

  /**
   * Process a new change submission: check permissions, analyze intent, route accordingly.
   */
  async processSubmission(params: {
    repoId: string;
    agentId: string | null;
    intent: string;
    description?: string;
    branch: string;
    files: { path: string; action: string; content?: string }[];
    riskAssessment?: { level: string; reasoning: string };
    source?: "api" | "git_push";
  }) {
    // Get repo
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, params.repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", params.repoId);
    }

    // Get permission rules for this repo
    const rules = await this.db
      .select()
      .from(permissionRules)
      .where(eq(permissionRules.repoId, params.repoId));

    const filePaths = params.files.map((f) => f.path);
    const fileActions = params.files.map((f) => f.action);

    // Evaluate permissions
    const permResult = evaluatePermissions(
      rules,
      params.agentId,
      filePaths,
      fileActions
    );

    if (!permResult.allowed) {
      throw new ValidationError(
        `Access denied for paths: ${permResult.deniedPaths.join(", ")}`
      );
    }

    // Analyze intent (LLM or heuristic)
    const analysis = await this.intentEngine.analyzeChange({
      intent: params.intent,
      description: params.description,
      files: params.files,
      existingRiskLevel: params.riskAssessment?.level,
    });

    // Create branch in git
    await this.gitService.createBranch(
      repo.gitPath,
      params.branch,
      repo.defaultBranch
    );

    // Apply file changes
    await this.gitService.applyDiff(
      repo.gitPath,
      params.branch,
      params.files.map((f) => ({
        path: f.path,
        action: (f.action ?? "create") as "create" | "modify" | "delete",
        content: f.content,
      })),
      params.intent
    );

    // Build diff summary
    const diffSummary = {
      files_changed: params.files.length,
      files: params.files.map((f) => ({
        path: f.path,
        action: f.action ?? "create",
      })),
    };

    // Determine initial status based on permissions and risk
    let initialStatus: ChangeStatus = "pending";
    if (
      permResult.autoMerge &&
      !permResult.requiresApproval &&
      (analysis.riskLevel === "low" || analysis.riskLevel === "medium")
    ) {
      initialStatus = "approved";
    }

    // Store the change
    const [change] = await this.db
      .insert(changes)
      .values({
        repoId: params.repoId,
        agentId: params.agentId,
        intent: params.intent,
        description: analysis.summary,
        status: initialStatus,
        riskLevel: analysis.riskLevel,
        branch: params.branch,
        source: params.source ?? "api",
        diffSummary,
        semanticDiff: {
          reasoning: params.riskAssessment?.reasoning ?? null,
          architectural_impact: analysis.architecturalImpact,
        },
      })
      .returning();

    // Audit event
    await this.db.insert(auditEvents).values({
      repoId: params.repoId,
      agentId: params.agentId,
      action: "change_created",
      metadata: {
        changeId: change.id,
        intent: params.intent,
        riskLevel: analysis.riskLevel,
        autoApproved: initialStatus === "approved",
      },
    });

    // Publish change refs
    if (this.changeRefService) {
      try {
        const { hasConflicts } = await this.changeRefService.publishChangeRefs(
          repo.gitPath,
          change.id,
          params.branch,
          repo.defaultBranch
        );
        if (hasConflicts) {
          await this.db
            .update(changes)
            .set({ hasConflicts: true })
            .where(eq(changes.id, change.id));
        }
      } catch {
        // Non-fatal: change refs are supplementary
      }
    }

    // Emit event
    await this.eventBus.emit({
      type: "change.created",
      repoId: params.repoId,
      agentId: params.agentId ?? undefined,
      data: {
        changeId: change.id,
        intent: params.intent,
        riskLevel: analysis.riskLevel,
        status: initialStatus,
        branch: params.branch,
        filesChanged: params.files.length,
      },
      timestamp: new Date().toISOString(),
    });

    // If auto-approved, also auto-merge
    if (initialStatus === "approved") {
      await this.mergeChange(change.id, params.repoId, null);
    }

    // Re-fetch to get latest status (may have been merged)
    const [latest] = await this.db
      .select()
      .from(changes)
      .where(eq(changes.id, change.id))
      .limit(1);

    return latest ?? change;
  }

  /**
   * Approve a pending change.
   */
  async approveChange(
    changeId: string,
    repoId: string,
    reviewerId: string
  ) {
    const [change] = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    this.validateTransition(change.status as ChangeStatus, "approved");

    const [updated] = await this.db
      .update(changes)
      .set({
        status: "approved",
        reviewedAt: new Date(),
        reviewedBy: reviewerId,
      })
      .where(eq(changes.id, changeId))
      .returning();

    await this.db.insert(auditEvents).values({
      repoId,
      agentId: change.agentId,
      action: "change_approved",
      metadata: { changeId, reviewerId },
    });

    await this.eventBus.emit({
      type: "change.approved",
      repoId,
      agentId: change.agentId ?? undefined,
      data: { changeId, reviewerId },
      timestamp: new Date().toISOString(),
    });

    return updated;
  }

  /**
   * Reject a pending or approved change.
   */
  async rejectChange(
    changeId: string,
    repoId: string,
    reviewerId: string,
    reason?: string
  ) {
    const [change] = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    this.validateTransition(change.status as ChangeStatus, "rejected");

    const [updated] = await this.db
      .update(changes)
      .set({
        status: "rejected",
        reviewedAt: new Date(),
        reviewedBy: reviewerId,
      })
      .where(eq(changes.id, changeId))
      .returning();

    await this.db.insert(auditEvents).values({
      repoId,
      agentId: change.agentId,
      action: "change_rejected",
      metadata: { changeId, reviewerId, reason },
    });

    await this.eventBus.emit({
      type: "change.rejected",
      repoId,
      agentId: change.agentId ?? undefined,
      data: { changeId, reviewerId, reason },
      timestamp: new Date().toISOString(),
    });

    // Clean up change refs after rejection
    if (this.changeRefService) {
      try {
        // Need repo to get gitPath
        const [rejectRepo] = await this.db
          .select()
          .from(repositories)
          .where(eq(repositories.id, repoId))
          .limit(1);
        if (rejectRepo) {
          await this.changeRefService.cleanupChangeRefs(
            rejectRepo.gitPath,
            changeId
          );
        }
      } catch {
        // Non-fatal
      }
    }

    return updated;
  }

  /**
   * Merge an approved change into the default branch.
   */
  async mergeChange(
    changeId: string,
    repoId: string,
    reviewerId: string | null
  ) {
    const [change] = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    // Allow merge from "approved" status
    if (change.status !== "approved") {
      this.validateTransition(change.status as ChangeStatus, "merged");
    }

    // Get repo for git path
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    // Perform the git merge
    await this.gitService.mergeBranch(
      repo.gitPath,
      change.branch,
      repo.defaultBranch
    );

    const [updated] = await this.db
      .update(changes)
      .set({
        status: "merged",
        reviewedAt: reviewerId ? new Date() : change.reviewedAt,
        reviewedBy: reviewerId ?? change.reviewedBy,
      })
      .where(eq(changes.id, changeId))
      .returning();

    await this.db.insert(auditEvents).values({
      repoId,
      agentId: change.agentId,
      action: "change_merged",
      metadata: { changeId, reviewerId, branch: change.branch },
    });

    await this.eventBus.emit({
      type: "change.merged",
      repoId,
      agentId: change.agentId ?? undefined,
      data: { changeId, branch: change.branch, reviewerId },
      timestamp: new Date().toISOString(),
    });

    // Clean up change refs after merge
    if (this.changeRefService) {
      try {
        await this.changeRefService.cleanupChangeRefs(repo.gitPath, changeId);
      } catch {
        // Non-fatal
      }
    }

    return updated;
  }

  /**
   * Rollback a merged change.
   */
  async rollbackChange(
    changeId: string,
    repoId: string,
    reviewerId: string
  ) {
    const [change] = await this.db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    this.validateTransition(change.status as ChangeStatus, "rolled_back");

    // Get repo for git path
    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) {
      throw new NotFoundError("Repository", repoId);
    }

    // Rollback in git
    await this.gitService.rollbackMerge(repo.gitPath, repo.defaultBranch);

    const [updated] = await this.db
      .update(changes)
      .set({
        status: "rolled_back",
        reviewedAt: new Date(),
        reviewedBy: reviewerId,
      })
      .where(eq(changes.id, changeId))
      .returning();

    await this.db.insert(auditEvents).values({
      repoId,
      agentId: change.agentId,
      action: "change_rolled_back",
      metadata: { changeId, reviewerId },
    });

    await this.eventBus.emit({
      type: "change.rolled_back",
      repoId,
      agentId: change.agentId ?? undefined,
      data: { changeId, reviewerId },
      timestamp: new Date().toISOString(),
    });

    return updated;
  }
}
