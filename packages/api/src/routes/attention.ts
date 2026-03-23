import { Hono } from "hono";
import { eq, and, or, inArray } from "drizzle-orm";
import {
  changes,
  repositories,
  reviews,
  users,
  agents,
  humanSummaries,
} from "../models/schema.js";
import {
  ValidationError,
  NotFoundError,
  AuthError,
} from "../services/errors.js";
import { canMerge } from "../services/merge-policy.js";
import type { MergePolicy } from "../services/merge-policy.js";
import { validateHumanSummary } from "../services/human-summary-validator.js";
import type { Database } from "../models/db.js";
import type { ChangeService } from "../services/changes.js";
import type { EventBus } from "../services/events.js";

import { resolveRepoByOwnerAndName } from "../services/repo-resolver.js";

export function createAttentionRoutes(
  db: Database,
  changeService: ChangeService,
  eventBus: EventBus
) {
  // Feed app: mounted at /attention
  const feed = new Hono();

  // GET /api/v1/attention — Items needing human attention
  feed.get("/", async (c) => {
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new AuthError("Only users can view the attention feed");
    }

    // Find all repos visible to this user (owned directly or via claimed agents)
    const claimedAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.ownerId, payload.sub));
    const agentIds = claimedAgents.map((a) => a.id);

    const conditions = [eq(repositories.ownerId, payload.sub)];
    if (agentIds.length > 0) {
      conditions.push(inArray(repositories.ownerAgentId, agentIds));
    }

    const userRepos = await db
      .select()
      .from(repositories)
      .where(or(...conditions));

    if (userRepos.length === 0) {
      return c.json({ items: [] });
    }

    const items: Array<{
      change: Record<string, unknown>;
      repository: Record<string, unknown>;
      escalation_reason: string | null;
      human_summary: Record<string, unknown> | null;
      reviews: Array<Record<string, unknown>>;
    }> = [];

    for (const repo of userRepos) {
      // Find escalated changes in this repo
      const escalatedChanges = await db
        .select()
        .from(changes)
        .where(
          and(
            eq(changes.repoId, repo.id),
            eq(changes.escalated, true)
          )
        );

      for (const change of escalatedChanges) {
        // Skip terminal states
        if (change.status === "merged" || change.status === "rolled_back") {
          continue;
        }

        // Fetch reviews for this change
        const changeReviews = await db
          .select()
          .from(reviews)
          .where(eq(reviews.changeId, change.id))
          .orderBy(reviews.createdAt);

        // Fetch human summary if one exists
        let humanSummary: Record<string, unknown> | null = null;
        if (change.humanSummaryId) {
          const [hs] = await db
            .select()
            .from(humanSummaries)
            .where(eq(humanSummaries.id, change.humanSummaryId))
            .limit(1);
          if (hs) {
            humanSummary = {
              id: hs.id,
              headline: hs.headline,
              what_happened: hs.whatHappened,
              why_care: hs.whyCare,
              key_decisions: hs.keyDecisions,
              uncertainty: hs.uncertainty,
              recommendation: hs.recommendation,
              confidence: hs.confidence,
              submitted_by: hs.submittedBy,
              submitted_at: hs.submittedAt,
            };
          }
        }

        items.push({
          change: {
            id: change.id,
            repo_id: change.repoId,
            author_id: change.authorId,
            author_type: change.authorType,
            branch: change.branch,
            intent: change.intent,
            risk_level: change.riskLevel,
            scope: change.scope,
            decisions: change.decisions,
            status: change.status,
            escalated: change.escalated,
            has_conflicts: change.hasConflicts,
            human_summary_id: change.humanSummaryId,
            created_at: change.createdAt,
            updated_at: change.updatedAt,
          },
          repository: {
            id: repo.id,
            name: repo.name,
            owner_id: repo.ownerId,
          },
          escalation_reason: change.escalationReason,
          human_summary: humanSummary,
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
            created_at: r.createdAt,
          })),
        });
      }
    }

    return c.json({ items });
  });

  // Actions app: mounted at /repos (alongside other repo routes)
  const actions = new Hono();

  // POST /api/v1/repos/:owner/:repo/changes/:id/human-summary — Submit agent-generated summary
  actions.post("/:owner/:repo/changes/:id/human-summary", async (c) => {
    const payload = c.get("tokenPayload");
    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const changeId = c.req.param("id");

    // Resolve repo
    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }
    const repo = result.repo;

    // Only the repo's owner agent or the human owner can submit
    let submittingAgentId: string | null = null;
    if (payload.type === "agent") {
      // Verify this agent is the repo's owner agent
      if (repo.ownerAgentId && payload.sub === repo.ownerAgentId) {
        submittingAgentId = payload.sub;
      } else {
        // Check if this agent is owned by the repo owner
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, payload.sub))
          .limit(1);
        if (!agent || agent.ownerId !== repo.ownerId) {
          throw new AuthError(
            "Only the repository owner's agent can submit human summaries"
          );
        }
        submittingAgentId = payload.sub;
      }
    } else {
      // Human owner submitting — verify ownership
      if (payload.sub !== repo.ownerId) {
        throw new AuthError(
          "Only the repository owner can submit human summaries"
        );
      }
      // For human submissions, find their primary agent or use their own ID
      const ownerAgents = await db
        .select()
        .from(agents)
        .where(eq(agents.ownerId, payload.sub))
        .limit(1);
      submittingAgentId = ownerAgents[0]?.id ?? null;
      if (!submittingAgentId) {
        throw new ValidationError(
          "No agent found for this user. Register an agent first."
        );
      }
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

    const body = await c.req.json();

    // Validate against schema
    const validationResult = validateHumanSummary(
      body as Record<string, unknown>,
      change.scope
    );

    if (!validationResult.valid) {
      return c.json(
        {
          error: "human_summary_validation_failed",
          message:
            "The submitted summary does not match the required schema. Fix the errors below and resubmit.",
          errors: validationResult.errors,
        },
        400
      );
    }

    const summary = validationResult.summary;

    // Store the summary
    const [stored] = await db
      .insert(humanSummaries)
      .values({
        changeId: change.id,
        submittedBy: submittingAgentId,
        headline: summary.headline,
        whatHappened: summary.what_happened,
        whyCare: summary.why_care,
        keyDecisions: summary.key_decisions,
        uncertainty: summary.uncertainty,
        recommendation: summary.recommendation,
        confidence: summary.confidence,
      })
      .returning();

    // Link to change
    await db
      .update(changes)
      .set({ humanSummaryId: stored.id, updatedAt: new Date() })
      .where(eq(changes.id, change.id));

    // Emit event
    await eventBus.emit({
      type: "human_summary.submitted",
      repoId: repo.id,
      actorId: payload.sub,
      actorType: payload.type === "agent" ? "agent" : "human",
      data: {
        changeId,
        summaryId: stored.id,
      },
      timestamp: new Date().toISOString(),
    });

    return c.json(
      {
        id: stored.id,
        change_id: stored.changeId,
        status: "accepted",
        message: "Human summary accepted and attached to the change.",
      },
      201
    );
  });

  // POST /api/v1/repos/:owner/:repo/changes/:id/human-approve — Human override approval
  actions.post("/:owner/:repo/changes/:id/human-approve", async (c) => {
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new AuthError("Only users can human-approve changes");
    }

    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const changeId = c.req.param("id");

    // Resolve repo
    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }
    const repo = result.repo;

    // Verify the user owns this repo
    if (repo.ownerId !== payload.sub) {
      throw new AuthError("You do not own this repository");
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

    // Clear escalation
    await db
      .update(changes)
      .set({
        escalated: false,
        updatedAt: new Date(),
      })
      .where(eq(changes.id, changeId));

    // Create a human approval review record
    const [review] = await db
      .insert(reviews)
      .values({
        changeId,
        reviewerId: payload.sub,
        reviewerType: "human",
        verdict: "approve",
        summary: "Human override approval",
      })
      .returning();

    // Emit event
    await eventBus.emit({
      type: "change.human_approved",
      repoId: repo.id,
      actorId: payload.sub,
      actorType: "human",
      data: {
        changeId,
        reviewId: review.id,
      },
      timestamp: new Date().toISOString(),
    });

    // Evaluate merge policy — if now satisfied, auto-merge
    const allReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.changeId, changeId));

    // Re-read change (escalated is now false)
    const [updatedChange] = await db
      .select()
      .from(changes)
      .where(eq(changes.id, changeId))
      .limit(1);

    const policy = repo.mergePolicy as MergePolicy;
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

    let merged = false;
    if (mergeResult.allowed) {
      try {
        await changeService.updateStatus(changeId, "approved");
      } catch {
        // May already be approved
      }
      try {
        await changeService.mergeChange(changeId, payload.sub, "human");
        merged = true;
      } catch {
        // Merge may fail; non-fatal
      }
    } else {
      // At least mark as approved
      try {
        await changeService.updateStatus(changeId, "approved");
      } catch {
        // May already be approved
      }
    }

    return c.json({
      approved: true,
      merged,
      merge_evaluation: mergeResult,
    });
  });

  // POST /api/v1/repos/:owner/:repo/changes/:id/human-reject — Human override rejection
  actions.post("/:owner/:repo/changes/:id/human-reject", async (c) => {
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new AuthError("Only users can human-reject changes");
    }

    const owner = c.req.param("owner");
    const repoName = c.req.param("repo");
    const changeId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));

    const reason = body.reason ?? "Rejected by human review";

    // Resolve repo
    const result = await resolveRepoByOwnerAndName(db, owner, repoName);
    if (!result) {
      throw new NotFoundError("Repository", `${owner}/${repoName}`);
    }
    const repo = result.repo;

    // Verify the user owns this repo
    if (repo.ownerId !== payload.sub) {
      throw new AuthError("You do not own this repository");
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

    // Set status to changes_requested
    await changeService.updateStatus(changeId, "changes_requested");

    // Clear escalation and record reason
    await db
      .update(changes)
      .set({
        escalated: false,
        escalationReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(changes.id, changeId));

    // Create a human rejection review record
    const [review] = await db
      .insert(reviews)
      .values({
        changeId,
        reviewerId: payload.sub,
        reviewerType: "human",
        verdict: "request_changes",
        summary: reason,
      })
      .returning();

    // Emit event
    await eventBus.emit({
      type: "change.human_rejected",
      repoId: repo.id,
      actorId: payload.sub,
      actorType: "human",
      data: {
        changeId,
        reviewId: review.id,
        reason,
      },
      timestamp: new Date().toISOString(),
    });

    return c.json({
      rejected: true,
      reason,
    });
  });

  return { feed, actions };
}
