import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, issues, issueChanges, reviews, verificationRuns } from "../models/schema.js";
import type { ReviewBrief } from "../services/focus-synthesis.js";
import type { GitService } from "../services/git.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import type { ReviewFocus } from "../services/trailer-parser.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

export function createChangeRoutes(db: DB, git: GitService, changeSvc: ChangeService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/changes", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(changes).where(eq(changes.repoId, repo.id)).orderBy(desc(changes.updatedAt)).limit(100);
    // Enrich each row with the author's display name (agent name or human handle)
    // so the list can show who opened each change.
    return c.json({ changes: await changeSvc.withAuthors(rows) });
  });

  app.get("/:ns/:repo/changes/:id", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const decision = await changeSvc.evaluate(row.id);
    const author = await changeSvc.authorInfo(row);
    // behindBase drives the "Update branch" affordance — base has commits the change lacks.
    const behindBase = await changeSvc.isBehindBase(row);
    // Linked issues (#13) — the reverse of issue→change linking.
    const linkedIssues = await db.select({ number: issues.number, title: issues.title, status: issues.status })
      .from(issueChanges).innerJoin(issues, eq(issues.id, issueChanges.issueId))
      .where(eq(issueChanges.changeId, row.id)).orderBy(issues.number);
    // Conformance verification for the CURRENT head (M5) — drives the verification
    // panel (per-check rows, spec-basis chip, undeclared-scope banner). A new push
    // moves the head → this stops matching, so a stale attestation never shows.
    const verification = (await db.select().from(verificationRuns)
      .where(and(eq(verificationRuns.changeId, row.id), eq(verificationRuns.headCommit, row.headCommit)))
      .orderBy(desc(verificationRuns.reportedAt)).limit(1))[0] ?? null;
    return c.json({ change: { ...row, ...author }, mergeable: decision, linkedIssues, behindBase, verification });
  });

  // Edit a Change's description (the `intent`). Until now `intent` was frozen at
  // push time (from the commit `Intent:` trailer). Editing description METADATA
  // is NOT a git commit, so a user JWT is valid here — both user and agent
  // writers may edit; the "only agents commit" transport invariant is unchanged.
  app.patch("/:ns/:repo/changes/:id", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { intent?: string };
    const updated = await changeSvc.updateIntent(row.id, body.intent as string, {
      kind: p.kind === "agent" ? "agent" : "human",
      id: p.kind === "agent" ? p.agentId : p.userId,
    });
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "agent" ? "agent" : "human",
      actorId: p.kind === "agent" ? p.agentId : p.userId,
      action: "change.intent.updated", category: "change",
      metadata: { changeId: row.id },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    const decision = await changeSvc.evaluate(updated.id);
    const linkedIssues = await db.select({ number: issues.number, title: issues.title, status: issues.status })
      .from(issueChanges).innerJoin(issues, eq(issues.id, issueChanges.issueId))
      .where(eq(issueChanges.changeId, updated.id)).orderBy(issues.number);
    return c.json({ change: updated, mergeable: decision, linkedIssues });
  });

  app.get("/:ns/:repo/changes/:id/diff", async c => {
    const { namespace, repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const mode = (c.req.query("mode") ?? "focused") === "full" ? "full" : "focused";

    // Pick a diff base that survives the merge. Diffing against the default
    // branch goes blank the moment the change is merged (head becomes an
    // ancestor). For merge/squash the merge commit's first parent is exactly
    // the pre-merge tip; otherwise fall back to the merge-base, which also
    // gives pending changes a clean three-dot-style diff.
    let base: string;
    let target = row.headCommit;
    if (row.status === "merged" && row.mergeCommit && (row.mergeMethod === "merge" || row.mergeMethod === "squash")) {
      base = `${row.mergeCommit}^1`;
      target = row.mergeCommit;
    } else {
      base = (await git.mergeBase(namespace.name, repo.name, repo.defaultBranch, row.headCommit)) ?? repo.defaultBranch;
    }
    const raw = await git.diffRaw(namespace.name, repo.name, base, target);
    // Both modes return the SAME full, parseable `git diff` output. Focusing is a
    // pure client concern: <DiffReview> collapses to the flagged hunks (±3 lines)
    // from the merged focus set. The old server-side buildFocusedDiff emitted a
    // non-standard "### path" + bare "@@" shape that the client's unified-diff
    // parser silently dropped (it keys files on `diff --git`), so the focused tab
    // rendered nothing (#3). Returning raw fixes it with zero client diff changes.
    //
    // M1 "wire the dead pipe": the focus set is the UNION of three sources, each
    // source-tagged — the author's own Review-Focus/inline flags, the deterministic
    // Review Brief the server synthesized, and reviewer `additionalFocus` (which
    // was stored but never rendered — the single highest-leverage dead wire in the
    // repo). Deduped by (path,startLine,endLine); author wins a tie, then reviewer.
    const authorFocus: ReviewFocus[] = ((row.reviewFocus as ReviewFocus[]) ?? []).map(f => ({ ...f, source: "author" as const }));
    const brief = row.reviewBrief as ReviewBrief | null;
    const derivedFocus: ReviewFocus[] = (brief?.derivedFocus ?? []).map(f => ({
      path: f.path, startLine: f.startLine, endLine: f.endLine, note: f.reason, source: "derived" as const,
    }));
    // Exclude ADVISORY (native-reviewer) focus from the diff's gating-reviewer
    // union — a machine suggestion must not render indistinguishably from a human
    // reviewer's flag. The advisory reviewer's focus is surfaced separately by the
    // AdvisoryReviewCard.
    const reviewRows = await db.select({ additionalFocus: reviews.additionalFocus })
      .from(reviews).where(and(eq(reviews.changeId, row.id), isNull(reviews.supersededAt), eq(reviews.advisory, false)));
    const reviewerFocus: ReviewFocus[] = reviewRows.flatMap(rr =>
      ((rr.additionalFocus as ReviewFocus[]) ?? []).map(f => ({ ...f, source: "reviewer" as const })));
    const focus = mergeFocusSources(authorFocus, reviewerFocus, derivedFocus);
    return c.json({ mode, diff: raw, focus });
  });

  app.post("/:ns/:repo/changes/:id/merge", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { method?: "merge" | "squash" | "rebase" };
    const method = body.method && ["merge", "squash", "rebase"].includes(body.method) ? body.method : "merge";
    const result = await changeSvc.merge(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId }, method);
    return c.json({ ok: true, ...result });
  });

  // Arm / cancel "merge when ready": land this change automatically the moment its
  // gate goes green (CI passes, approvals in). Human-only (agents use verified
  // autonomy); write access. The arm is pinned to the current head — a new push voids
  // it. Setting it tries an immediate enqueue in case the gate is already green.
  app.post("/:ns/:repo/changes/:id/auto-merge", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("only a human can arm merge-when-ready");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { method?: "merge" | "squash" | "rebase" };
    const method = body.method && ["merge", "squash", "rebase"].includes(body.method) ? body.method : undefined;
    const merged = await changeSvc.armAutoMerge(row.id, p.userId, method);
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: "human", actorId: p.userId,
      action: "change.auto_merge_armed", category: "change", metadata: { changeId: row.id, method: method ?? "default", mergedImmediately: merged },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, armed: true, mergedImmediately: merged });
  });
  app.delete("/:ns/:repo/changes/:id/auto-merge", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("only a human can cancel merge-when-ready");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    await changeSvc.disarmAutoMerge(row.id);
    return c.json({ ok: true, armed: false });
  });

  // Bring a Change current with its base branch (rebase / merge-base-in) — the
  // "Update branch" button. Write access; content conflicts return 409.
  app.post("/:ns/:repo/changes/:id/update-branch", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { method?: string };
    const method = body.method === "rebase" ? "rebase" : "merge";
    const result = await changeSvc.updateBranch(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId }, method);
    return c.json({ ok: true, ...result });
  });

  app.post("/:ns/:repo/changes/:id/rollback", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    // Optional reason: WHY it is being rolled back — captured into repo memory so
    // agents learn from the failure instead of repeating it.
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
    await changeSvc.rollback(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId }, { reason });
    return c.json({ ok: true });
  });

  // Abandon an UNMERGED Change — close a garbage/dead-end diff without merging
  // (distinct from rollback, which reverts a merged change). Repo-write gated; the
  // author has write (they pushed it). Reopenable via /reopen.
  app.post("/:ns/:repo/changes/:id/abandon", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 1000) : null;
    await changeSvc.abandon(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId }, { reason });
    return c.json({ ok: true });
  });

  // Undo a mis-clicked "request changes": dismiss the change's request_changes
  // verdicts and return it to pending. Requires repo write (a reviewer/maintainer).
  app.post("/:ns/:repo/changes/:id/reopen", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    await changeSvc.reopen(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId });
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/changes/:id/draft", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { draft?: boolean };
    await changeSvc.markDraft(row.id, body.draft !== false);
    return c.json({ ok: true });
  });

  // Publish a draft → it leaves draft state and emits change.ready, which dispatches
  // the verify reviewer (reviewers only run on published diffs). The inverse of /draft.
  app.post("/:ns/:repo/changes/:id/publish", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    await changeSvc.markDraft(row.id, false);
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/changes/:id/reviewers", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), p);
    const row = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("change");
    const body = await c.req.json().catch(() => ({})) as { reviewers?: Array<{ kind: "agent" | "human"; id: string }> };
    await changeSvc.requestReviewers(row.id, body.reviewers ?? [], p.kind === "user" ? p.userId : undefined);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Union of author / reviewer / derived focus, deduped by (path,startLine,endLine).
 * Earlier arguments win a tie — pass author first, then reviewer, then derived,
 * so the deterministic floor never overrides a human/agent's explicit flag on
 * the same lines. Sorted by (path, startLine) for a stable render order.
 */
function mergeFocusSources(...groups: ReviewFocus[][]): ReviewFocus[] {
  const byKey = new Map<string, ReviewFocus>();
  for (const group of groups) {
    for (const f of group) {
      const key = `${f.path}:${f.startLine}:${f.endLine}`;
      if (!byKey.has(key)) byKey.set(key, f);
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine);
}
