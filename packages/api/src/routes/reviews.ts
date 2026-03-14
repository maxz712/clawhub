import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { reviews, changes } from "../models/schema.js";
import { ValidationError, NotFoundError } from "../services/errors.js";
import type { Database } from "../models/db.js";
import type { ChangeService } from "../services/changes.js";
import type { EventBus } from "../services/events.js";

export function createReviewRoutes(
  db: Database,
  changeService: ChangeService,
  eventBus: EventBus
) {
  const app = new Hono();

  // POST /api/v1/repos/:id/changes/:changeId/reviews — Submit a review
  app.post("/:id/changes/:changeId/reviews", async (c) => {
    const repoId = c.req.param("id");
    const changeId = c.req.param("changeId");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    const { verdict, summary, comments: reviewComments } = body;

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
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
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
        comments: reviewComments ?? null,
      })
      .returning();

    // Emit event
    await eventBus.emit({
      type: "review.submitted",
      repoId,
      data: {
        reviewId: review.id,
        changeId,
        reviewerId: payload.sub,
        reviewerType,
        verdict,
      },
      timestamp: new Date().toISOString(),
    });

    // If verdict is "approve" and reviewer is a user (human), also approve the change
    if (verdict === "approve" && payload.type === "user") {
      try {
        await changeService.approveChange(changeId, repoId, payload.sub);
      } catch {
        // Change may already be approved or in a non-transitionable state; that's OK
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
          comments: review.comments,
          created_at: review.createdAt,
        },
      },
      201
    );
  });

  // GET /api/v1/repos/:id/changes/:changeId/reviews — List reviews for a change
  app.get("/:id/changes/:changeId/reviews", async (c) => {
    const changeId = c.req.param("changeId");
    const repoId = c.req.param("id");

    // Verify the change exists and belongs to this repo
    const [change] = await db
      .select()
      .from(changes)
      .where(and(eq(changes.id, changeId), eq(changes.repoId, repoId)))
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
        comments: r.comments,
        created_at: r.createdAt,
      })),
    });
  });

  return app;
}
