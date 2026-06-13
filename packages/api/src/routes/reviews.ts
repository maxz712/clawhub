import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, reviews } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { resolveAndRecordMentions } from "../services/mentions.js";
import { enforceRate } from "../services/agent-scope.js";

export function createReviewRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/changes/:id/reviews", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const rows = await db.select().from(reviews).where(eq(reviews.changeId, change.id));
    return c.json({ reviews: rows });
  });

  app.post("/:ns/:repo/changes/:id/reviews", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");

    const body = await c.req.json().catch(() => ({})) as {
      verdict?: "approve" | "request_changes" | "comment";
      basis?: "behavior" | "code" | "both";
      summary?: string;
      additionalFocus?: Array<{ path: string; startLine: number; endLine: number; note?: string }>;
    };
    if (!body.verdict || !["approve", "request_changes", "comment"].includes(body.verdict)) throw new ValidationError("bad verdict");
    // Basis records what the approval rests on; code-level review is what
    // satisfies the merge gate at high risk. Defaults to "code".
    const basis = body.basis ?? "code";
    if (!["behavior", "code", "both"].includes(basis)) throw new ValidationError("bad basis");

    const reviewerKind = p.kind === "user" ? "human" : "agent";
    const reviewerId = p.kind === "user" ? p.userId : p.agentId;

    if (reviewerKind === "agent") await enforceRate(db, reviewerId, "review");

    const inserted = (await db.insert(reviews).values({
      changeId: change.id,
      reviewerKind,
      reviewerId,
      verdict: body.verdict,
      basis,
      summary: body.summary ?? null,
      additionalFocus: body.additionalFocus ?? [],
    }).returning())[0];

    if (reviewerKind === "agent") {
      await db.execute(sql`update agents set stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{reviewsSubmitted}', to_jsonb(coalesce((stats->>'reviewsSubmitted')::int, 0) + 1)) where id = ${reviewerId}`);
    }

    if (body.summary) {
      await resolveAndRecordMentions(db, body.summary, {
        repoId: repo.id,
        sourceKind: "review",
        sourceId: inserted.id,
        author: { kind: reviewerKind, id: reviewerId },
      });
    }

    if (body.verdict === "approve") {
      await db.update(changes).set({ status: change.status === "pending" ? "approved" : change.status, updatedAt: new Date() }).where(eq(changes.id, change.id));
    } else if (body.verdict === "request_changes") {
      await db.update(changes).set({ status: "changes_requested", updatedAt: new Date() }).where(eq(changes.id, change.id));
    }

    await events.publish({ type: "review.submitted", repoId: repo.id, changeId: change.id, actorKind: reviewerKind, actorId: reviewerId, payload: { verdict: body.verdict } });
    return c.json({ review: inserted }, 201);
  });

  return app;
}
