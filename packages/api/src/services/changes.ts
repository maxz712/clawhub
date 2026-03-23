import { eq, and } from "drizzle-orm";
import { changes, reviews, auditEvents, repositories } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import type { ChangeRefService } from "./change-refs.js";
import { canMerge } from "./merge-policy.js";
import { NotFoundError, ValidationError } from "./errors.js";

export type ChangeStatus = "pending_review" | "approved" | "changes_requested" | "merged" | "rolled_back";

const VALID_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pending_review: ["approved", "changes_requested"],
  approved: ["merged", "changes_requested"],
  changes_requested: ["pending_review", "approved"],  // can be re-pushed
  merged: ["rolled_back"],
  rolled_back: [],
};

export class ChangeService {
  constructor(
    private db: Database,
    private gitService: GitService,
    private eventBus: EventBus,
    private changeRefService: ChangeRefService
  ) {}

  private validateTransition(from: ChangeStatus, to: ChangeStatus): void {
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed?.includes(to)) {
      throw new ValidationError(`Cannot transition from '${from}' to '${to}'`);
    }
  }

  // Update change status (used after review evaluation)
  async updateStatus(changeId: string, newStatus: ChangeStatus): Promise<void> {
    const [change] = await this.db.select().from(changes).where(eq(changes.id, changeId)).limit(1);
    if (!change) throw new NotFoundError("Change", changeId);
    this.validateTransition(change.status as ChangeStatus, newStatus);
    await this.db.update(changes).set({ status: newStatus, updatedAt: new Date() }).where(eq(changes.id, changeId));
  }

  // Merge a change — checks merge policy first
  async mergeChange(changeId: string, actorId: string, actorType: 'agent' | 'human'): Promise<void> {
    const [change] = await this.db.select().from(changes).where(eq(changes.id, changeId)).limit(1);
    if (!change) throw new NotFoundError("Change", changeId);

    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1);
    if (!repo) throw new NotFoundError("Repository", change.repoId);

    // Get reviews
    const changeReviews = await this.db.select().from(reviews).where(eq(reviews.changeId, changeId));

    // Check merge policy
    const policy = repo.mergePolicy as any;
    const result = canMerge(policy, {
      riskLevel: change.riskLevel,
      scope: change.scope,
      authorId: change.authorId,
      escalated: change.escalated,
      commitCount: change.commitCount,
    }, changeReviews.map(r => ({
      verdict: r.verdict,
      reviewerId: r.reviewerId,
      reviewerType: r.reviewerType,
    })));

    if (!result.allowed) {
      throw new ValidationError(`Cannot merge: ${result.reason}`);
    }

    // Perform git merge
    await this.gitService.mergeBranch(repo.gitPath, change.branch, repo.defaultBranch);

    // Update status
    await this.db.update(changes).set({ status: "merged", updatedAt: new Date() }).where(eq(changes.id, changeId));

    // Audit + event
    await this.db.insert(auditEvents).values({
      repoId: change.repoId,
      actorId,
      actorType,
      action: "change_merged",
      metadata: { changeId, branch: change.branch },
    });

    await this.eventBus.emit({
      type: "change.merged",
      repoId: change.repoId,
      actorId,
      actorType,
      data: { changeId, branch: change.branch },
      timestamp: new Date().toISOString(),
    });

    // Clean up change refs
    try {
      await this.changeRefService.cleanupChangeRefs(repo.gitPath, changeId);
    } catch { /* non-fatal */ }
  }

  // Rollback a merged change
  async rollbackChange(changeId: string, actorId: string, actorType: 'agent' | 'human'): Promise<void> {
    const [change] = await this.db.select().from(changes).where(eq(changes.id, changeId)).limit(1);
    if (!change) throw new NotFoundError("Change", changeId);

    this.validateTransition(change.status as ChangeStatus, "rolled_back");

    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1);
    if (!repo) throw new NotFoundError("Repository", change.repoId);

    await this.gitService.rollbackMerge(repo.gitPath, repo.defaultBranch);

    await this.db.update(changes).set({ status: "rolled_back", updatedAt: new Date() }).where(eq(changes.id, changeId));

    await this.db.insert(auditEvents).values({
      repoId: change.repoId,
      actorId,
      actorType,
      action: "change_rolled_back",
      metadata: { changeId },
    });

    await this.eventBus.emit({
      type: "change.rolled_back",
      repoId: change.repoId,
      actorId,
      actorType,
      data: { changeId },
      timestamp: new Date().toISOString(),
    });
  }
}
