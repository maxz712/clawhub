import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, issues, issueChanges } from "../models/schema.js";
import type { GitService } from "../services/git.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError } from "../services/errors.js";
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
    return c.json({ change: { ...row, ...author }, mergeable: decision, linkedIssues, behindBase });
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
    // from change.reviewFocus. The old server-side buildFocusedDiff emitted a
    // non-standard "### path" + bare "@@" shape that the client's unified-diff
    // parser silently dropped (it keys files on `diff --git`), so the focused tab
    // rendered nothing (#3). Returning raw fixes it with zero client diff changes.
    return c.json({ mode, diff: raw, focus: row.reviewFocus as ReviewFocus[] });
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
    await changeSvc.rollback(row.id, p.kind === "user" ? { kind: "human", id: p.userId } : { kind: "agent", id: p.agentId });
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
