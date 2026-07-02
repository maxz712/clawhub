import { and, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, type Change } from "../models/schema.js";
import { writeMemory } from "./memory.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// Server-side MECHANICAL capture of the platform's knowledge-bearing moments —
// rollbacks, CI failures, changes-requested reviews, human suggestion comments,
// change open/merge outcomes. These are the RAW (episodic) layer that reflect
// distills into durable conventions; without them the flywheel has no fuel.
// Everything here is a template over structured data ClawHub already holds:
// no LLM, no interpretation (the FIT split — same posture as risk-engine).
//
// Design rules:
// - Repo scope: this is shared repo knowledge, visible to every collaborator
//   agent's pack. Rows are PLATFORM-authored (createdByAgentId null): the
//   subject agent must not hold authorship rights over its own track record
//   (it could invalidate the rollback/CI-failure notes about itself). The
//   subject agent is recorded in facts.authorAgentId for display/analytics.
// - Idempotent: each capture pre-checks a live row with the same (scopeKey,
//   kind, title) — titles embed a short stable id (change/run/comment) so a
//   re-delivered event or retried request never duplicates.
// - Best-effort: capture must NEVER break the host flow (merge, rollback,
//   review submit, CI report). Callers use the exported capture* functions
//   which swallow + log failures and count clawhub_memory_capture_total.
// - Free text embedded in bodies must come from HUMAN or platform sources
//   where it carries authority (rollback reasons, review summaries) — agent-
//   sourced free text is limited to what the platform already renders
//   everywhere (the Intent trailer) and everything lands fenced as untrusted.

const short = (id: string | null | undefined): string => (id ?? "").slice(0, 8);
const trunc = (s: string | null | undefined, n: number): string => (s ?? "").slice(0, n);

/** Normalize free text into a stable, joinable error fingerprint. */
export function normalizeFingerprint(prefix: string, raw: string): string {
  const norm = raw.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return norm ? `${prefix}:${norm}` : "";
}

/** First failing step name out of a runner stepResults array (shape-tolerant). */
export function firstFailingStep(stepResults: unknown[] | undefined | null): string {
  if (!Array.isArray(stepResults)) return "";
  for (const s of stepResults) {
    if (!s || typeof s !== "object") continue;
    const r = s as { name?: unknown; status?: unknown; ok?: unknown };
    const failed = r.ok === false || (typeof r.status === "string" && ["failure", "failed", "error"].includes(r.status));
    if (failed) return typeof r.name === "string" ? r.name : "unnamed-step";
  }
  return "";
}

interface CaptureInput {
  repoId: string;
  /** The change's authoring agent (trust attribution) — null for human/platform. */
  agentId?: string | null;
  kind: "episode" | "failure";
  title: string;
  body: string;
  importance: number;
  facts: Record<string, unknown>;
  sourceRunId?: string | null;
  event: string; // metric label
}

async function capture(db: DB, input: CaptureInput): Promise<void> {
  try {
    const scopeKey = `repo:${input.repoId}`;
    const dup = (await db.select({ id: agentMemories.id }).from(agentMemories)
      .where(and(
        eq(agentMemories.scopeKey, scopeKey),
        eq(agentMemories.kind, input.kind),
        eq(agentMemories.title, input.title),
        isNull(agentMemories.validTo),
      )).limit(1))[0];
    if (dup) return;
    // PLATFORM-authored (agentId null in ScopeIds → createdByAgentId null): the
    // subject agent gets no authorship rights over its own track record. Its
    // identity is preserved in facts.authorAgentId instead.
    await writeMemory(db, { agentId: null, repoId: input.repoId, orgId: null }, {
      kind: input.kind,
      scope: "repo",
      title: input.title,
      body: input.body,
      importance: input.importance,
      facts: input.agentId ? { ...input.facts, authorAgentId: input.agentId } : input.facts,
      sourceRunId: input.sourceRunId ?? null,
    });
    metrics.inc("clawhub_memory_capture_total", { event: input.event });
  } catch (e) {
    log("warn", "memory_capture_failed", { event: input.event, err: (e as Error).message });
  }
}

type ChangeLike = Pick<Change, "id" | "repoId" | "intent" | "branch" | "changedPaths" | "openedByAgentId">;

const changePaths = (ch: ChangeLike): string[] =>
  Array.isArray(ch.changedPaths) ? (ch.changedPaths as unknown[]).filter((p): p is string => typeof p === "string").slice(0, 40) : [];

/** A new Change opened: its Intent trailer is already-distilled knowledge — free content. */
export async function captureChangeOpened(db: DB, ch: ChangeLike, opts: { scope?: string | null } = {}): Promise<void> {
  await capture(db, {
    repoId: ch.repoId, agentId: ch.openedByAgentId, kind: "episode", event: "change_opened",
    title: `Change opened: ${trunc(ch.intent, 90)} (${short(ch.id)})`,
    body: `Branch ${ch.branch}. Intent: ${trunc(ch.intent, 300)}.${opts.scope ? ` Scope: ${trunc(opts.scope, 120)}.` : ""}`,
    importance: 3,
    facts: { changeId: ch.id, paths: changePaths(ch) },
  });
}

/** Outcome stamp: the change landed (the success label for AWM-style induction). */
export async function captureChangeMerged(db: DB, ch: ChangeLike, opts: { actorName?: string | null } = {}): Promise<void> {
  await capture(db, {
    repoId: ch.repoId, agentId: ch.openedByAgentId, kind: "episode", event: "change_merged",
    title: `Change merged: ${trunc(ch.intent, 90)} (${short(ch.id)})`,
    body: `Merged${opts.actorName ? ` by ${opts.actorName}` : ""}. Intent: ${trunc(ch.intent, 300)}.`,
    importance: 3,
    facts: { changeId: ch.id, paths: changePaths(ch) },
  });
}

/** A merged change was rolled back — the strongest negative outcome the platform sees. */
export async function captureRollback(db: DB, ch: ChangeLike, opts: { reason?: string | null; actorName?: string | null } = {}): Promise<void> {
  const fp = opts.reason ? normalizeFingerprint("rollback", opts.reason) : "";
  await capture(db, {
    repoId: ch.repoId, agentId: ch.openedByAgentId, kind: "failure", event: "rollback",
    title: `Rolled back: ${trunc(ch.intent, 90)} (${short(ch.id)})`,
    body: `A MERGED change was rolled back${opts.actorName ? ` by ${opts.actorName}` : ""}${opts.reason ? `. Reason: ${trunc(opts.reason, 400)}` : ""}. Original intent: ${trunc(ch.intent, 200)}. Treat changes touching these files with extra care.`,
    importance: 7,
    facts: { changeId: ch.id, paths: changePaths(ch), ...(fp ? { errorFingerprint: fp } : {}) },
  });
}

/** A CI run failed. Fingerprinted by the first failing step so repeats cluster. */
export async function captureCiFailure(db: DB, opts: {
  runId: string; repoId: string; commit?: string | null;
  change?: ChangeLike | null; stepResults?: unknown[] | null;
}): Promise<void> {
  const step = firstFailingStep(opts.stepResults);
  const fp = normalizeFingerprint("ci", step || "unknown");
  const where = opts.change ? `change ${short(opts.change.id)}` : `commit ${short(opts.commit)}`;
  await capture(db, {
    repoId: opts.repoId, agentId: opts.change?.openedByAgentId ?? null, kind: "episode", event: "ci_failure",
    title: `CI failed on ${where}: ${trunc(step || "see run log", 80)} (${short(opts.runId)})`,
    body: `CI run failed${step ? ` at step "${trunc(step, 120)}"` : ""} on ${where}${opts.change ? ` (${trunc(opts.change.intent, 160)})` : ""}.`,
    importance: 4,
    facts: {
      ...(opts.change ? { changeId: opts.change.id, paths: changePaths(opts.change) } : {}),
      errorFingerprint: fp,
    },
    sourceRunId: opts.runId,
  });
}

/** A reviewer asked for changes — correction signal, strongest when human. */
export async function captureChangesRequested(db: DB, ch: ChangeLike, opts: {
  summary?: string | null; reviewerName?: string | null; reviewerKind: "human" | "agent"; reviewId: string;
}): Promise<void> {
  await capture(db, {
    repoId: ch.repoId, agentId: ch.openedByAgentId, kind: "episode", event: "changes_requested",
    title: `Changes requested on ${short(ch.id)}: ${trunc(opts.summary || ch.intent, 80)} (${short(opts.reviewId)})`,
    body: `${opts.reviewerKind === "human" ? "A HUMAN reviewer" : "A reviewer agent"}${opts.reviewerName ? ` (${opts.reviewerName})` : ""} requested changes${opts.summary ? `: ${trunc(opts.summary, 500)}` : ""}. Change intent: ${trunc(ch.intent, 160)}.`,
    importance: opts.reviewerKind === "human" ? 6 : 4,
    facts: { changeId: ch.id, paths: changePaths(ch) },
  });
}

/** A human inline review comment — path-anchored correction, the highest-value feedback. */
export async function captureReviewComment(db: DB, ch: ChangeLike, opts: {
  commentId: string; path?: string | null; body?: string | null; suggestion?: string | null; authorName?: string | null;
}): Promise<void> {
  const text = trunc(opts.body, 400);
  if (!text && !opts.suggestion) return; // nothing to learn from
  await capture(db, {
    repoId: ch.repoId, agentId: ch.openedByAgentId, kind: "episode", event: "review_comment",
    title: `Review comment${opts.path ? ` on ${trunc(opts.path, 80)}` : ""} in ${short(ch.id)} (${short(opts.commentId)})`,
    body: `Human review feedback${opts.authorName ? ` from ${opts.authorName}` : ""}${opts.path ? ` on ${opts.path}` : ""}: ${text}${opts.suggestion ? ` Suggested replacement: ${trunc(opts.suggestion, 300)}` : ""}`,
    importance: 5,
    facts: { changeId: ch.id, paths: opts.path ? [opts.path] : changePaths(ch) },
  });
}
