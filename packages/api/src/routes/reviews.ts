import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, reviews, reviewEvidence } from "../models/schema.js";

const EVIDENCE_KINDS = new Set(["test_output", "cli_output", "screenshot", "log", "link"]);
const EVIDENCE_CONTENT_CAP = 16_000; // inline output is capped like ci stepResults

interface EvidenceInput { kind?: string; label?: string; content?: string; url?: string; runId?: string }
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
    // Attach each review's evidence (test/CLI output, screenshots, linked CI runs).
    const ev = rows.length
      ? await db.select().from(reviewEvidence).where(inArray(reviewEvidence.reviewId, rows.map(r => r.id)))
      : [];
    const byReview = new Map<string, typeof ev>();
    for (const e of ev) (byReview.get(e.reviewId) ?? byReview.set(e.reviewId, []).get(e.reviewId)!).push(e);
    return c.json({ reviews: rows.map(r => ({ ...r, evidence: byReview.get(r.id) ?? [] })) });
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
      evidence?: EvidenceInput[];
    };
    if (!body.verdict || !["approve", "request_changes", "comment"].includes(body.verdict)) throw new ValidationError("bad verdict");
    // Validate any attached evidence up front (kind enum + at least one of
    // content/url) so a bad item rejects the whole review rather than half-saving.
    const evidence = Array.isArray(body.evidence) ? body.evidence : [];
    for (const e of evidence) {
      if (!e.kind || !EVIDENCE_KINDS.has(e.kind)) throw new ValidationError(`evidence.kind must be one of ${[...EVIDENCE_KINDS].join(", ")}`);
      if (!e.content && !e.url) throw new ValidationError("each evidence item needs content or url");
    }

    const reviewerKind = p.kind === "user" ? "human" : "agent";
    const reviewerId = p.kind === "user" ? p.userId : p.agentId;

    // Basis records what the approval rests on; code-level review is what
    // satisfies the merge gate at high risk, so it must NOT be invented on the
    // reviewer's behalf. When the caller doesn't say, default by reviewer kind:
    // a human (e.g. running the app via the CLI) most likely verified runtime
    // BEHAVIOR, not the code — recording that as "code" would silently corrupt
    // the audit trail and let behavior-only sign-off satisfy a code-review gate.
    // An agent reviewer programmatically inspects the diff, so "code" is right.
    const basis = body.basis ?? (reviewerKind === "human" ? "behavior" : "code");
    if (!["behavior", "code", "both"].includes(basis)) throw new ValidationError("bad basis");

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

    let evidenceRows: typeof reviewEvidence.$inferSelect[] = [];
    if (evidence.length) {
      evidenceRows = await db.insert(reviewEvidence).values(evidence.map(e => ({
        reviewId: inserted.id,
        repoId: repo.id,
        kind: e.kind!,
        label: e.label ?? null,
        content: e.content ? e.content.slice(0, EVIDENCE_CONTENT_CAP) : null,
        url: e.url ?? null,
        runId: e.runId ?? null,
      }))).returning();
    }

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
    return c.json({ review: { ...inserted, evidence: evidenceRows } }, 201);
  });

  return app;
}
