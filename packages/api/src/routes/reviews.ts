import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import {
  reviews,
  changes,
  repositories,
} from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
} from "../services/errors.js";
import { evaluateEscalation } from "../services/escalation.js";
import { canMerge } from "../services/merge-policy.js";
import type { MergePolicy } from "../services/merge-policy.js";
import {
  shouldRequestSummary,
  DEFAULT_SUMMARY_CONFIG,
} from "../services/human-summary-validator.js";
import type { HumanSummaryConfig } from "../services/human-summary-validator.js";
import type { Database } from "../models/db.js";
import type { ChangeService } from "../services/changes.js";
import type { EventBus } from "../services/events.js";

import { resolveRepoByOwnerAndName } from "../services/repo-resolver.js";

export function createReviewRoutes(
  db: Database,
  changeService: ChangeService,
  eventBus: EventBus
) {
  const app = new Hono();

  // POST /api/v1/repos/:owner/:repo/changes/:changeId/reviews — Submit a structured review
  app.post("/:owner/:repo/changes/:changeId/reviews", async (c) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    // Resolve repo
    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }
    const repo = result.repo;

    const {
      verdict,
      summary,
      decisions,
      uncertainty,
      verified_scope,
      unverified_scope,
      comments: reviewComments,
    } = body;

    if (!verdict) {
      throw new ValidationError("verdict is required");
    }

    const validVerdicts = ["approve", "request_changes", "comment"];
    if (!validVerdicts.includes(verdict)) {
      throw new ValidationError(
        `Invalid verdict. Must be one of: ${validVerdicts.join(", ")}`
      );
    }

    // Verify the change exists and belongs to this repo
    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const reviewerType = payload.type === "user" ? "human" : "agent";

    // Create review record
    const [review] = await db
      .insert(reviews)
      .values({
        changeId,
        reviewerId: payload.sub,
        reviewerType,
        verdict,
        summary: summary ?? null,
        decisions: decisions ?? null,
        uncertainty: uncertainty ?? null,
        verifiedScope: verified_scope ?? null,
        unverifiedScope: unverified_scope ?? null,
        comments: reviewComments ?? null,
      })
      .returning();

    // Emit review.submitted event
    await eventBus.emit({
      type: "review.submitted",
      repoId: repo.id,
      actorId: payload.sub,
      actorType: reviewerType,
      data: {
        reviewId: review.id,
        changeId,
        reviewerId: payload.sub,
        reviewerType,
        verdict,
      },
      timestamp: new Date().toISOString(),
    });

    // Evaluate escalation (e.g. reviewer flagged uncertainty)
    const escalationResult = evaluateEscalation(
      {
        riskLevel: change.riskLevel,
        scope: change.scope,
        commitCount: change.commitCount,
        hasConflicts: change.hasConflicts,
      },
      { uncertainty: uncertainty ?? null },
      repo.escalationPolicy as { rules: any[] } | null
    );

    if (escalationResult?.escalate) {
      await db
        .update(changes)
        .set({
          escalated: true,
          escalationReason: escalationResult.reason,
          updatedAt: new Date(),
        })
        .where(eq(changes.id, changeId));

      // Check if the owner's agent should be notified to produce a summary
      const summaryConfig =
        (repo.humanSummaryConfig as HumanSummaryConfig | null) ??
        DEFAULT_SUMMARY_CONFIG;

      const summaryRequested = shouldRequestSummary(
        summaryConfig,
        "escalation"
      );

      // Emit escalation event — the owner's agent listens for this
      // and generates + submits a human summary via the API
      await eventBus.emit({
        type: "escalation.triggered",
        repoId: repo.id,
        actorId: payload.sub,
        actorType: reviewerType,
        data: {
          changeId,
          reason: escalationResult.reason,
          summary_requested: summaryRequested,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Post-review status logic
    if (verdict === "request_changes") {
      // Update change status to changes_requested
      try {
        await changeService.updateStatus(changeId, "changes_requested");
      } catch {
        // May already be in changes_requested state; non-fatal
      }
    } else if (verdict === "approve") {
      // Fetch all reviews for this change to evaluate merge policy
      const allReviews = await db
        .select()
        .from(reviews)
        .where(eq(reviews.changeId, changeId));

      const policy = repo.mergePolicy as MergePolicy;

      // Re-read change in case escalation was just set
      const [updatedChange] = await db
        .select()
        .from(changes)
        .where(eq(changes.id, changeId))
        .limit(1);

      const mergeResult = canMerge(
        policy,
        {
          riskLevel: updatedChange.riskLevel,
          scope: updatedChange.scope,
          authorId: updatedChange.authorId,
          escalated: updatedChange.escalated,
          commitCount: updatedChange.commitCount,
        },
        allReviews.map((r) => ({
          verdict: r.verdict,
          reviewerId: r.reviewerId,
          reviewerType: r.reviewerType,
        }))
      );

      if (mergeResult.allowed) {
        // Auto-merge: approve then merge
        try {
          await changeService.updateStatus(changeId, "approved");
        } catch {
          // May already be approved
        }
        try {
          await changeService.mergeChange(changeId, payload.sub, reviewerType);
        } catch {
          // Merge may fail for various reasons; non-fatal in review context
        }
      } else {
        // Check if we have enough approvals to mark as approved (even if not mergeable yet)
        const approvals = allReviews.filter((r) => r.verdict === "approve");
        if (approvals.length >= (policy.min_approvals ?? 1)) {
          try {
            await changeService.updateStatus(changeId, "approved");
          } catch {
            // May already be approved
          }
        }
      }
    }

    return c.json(
      {
        review: {
          id: review.id,
          change_id: review.changeId,
          reviewer_id: review.reviewerId,
          reviewer_type: review.reviewerType,
          verdict: review.verdict,
          summary: review.summary,
          decisions: review.decisions,
          uncertainty: review.uncertainty,
          verified_scope: review.verifiedScope,
          unverified_scope: review.unverifiedScope,
          comments: review.comments,
          created_at: review.createdAt,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:owner/:repo/changes/:changeId/reviews — List reviews for a change
  app.get("/:owner/:repo/changes/:changeId/reviews", async (c) => {
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const changeId = c.req.param("changeId");

    // Resolve repo
    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }
    const repo = result.repo;

    // Verify the change exists and belongs to this repo
    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repo.id)))
      .limit(1);

    if (!change) {
      throw new NotFoundError("Change", changeId);
    }

    const changeReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId))
      .orderBy(reviews.createdAt);

    return c.json({
      reviews: changeReviews.map((r) => ({
        id: r.id,
        change_id: r.changeId,
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

  return app;
}
