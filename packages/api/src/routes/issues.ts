import { Hono } from "hono";
import { and, desc, eq, ilike, or, asc, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, issues, issueChanges, issueComments, milestones, agents, users } from "../models/schema.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForReview, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { resolveAndRecordMentions } from "../services/mentions.js";
import { deliverMentions } from "../services/notifications.js";
import { agentHasRepoGrant, applyIssueRouting, listIssueRoutingRules, setIssueRoutingRule, deleteIssueRoutingRule } from "../services/issue-routing.js";
import { handleSlashComment } from "../services/slash-commands.js";
import { insertIssueWithNumber } from "../services/issue-number.js";

export function createIssueRoutes(db: DB, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/issues", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const status = c.req.query("status");
    const assigned = c.req.query("assigned");
    const milestone = c.req.query("milestone");
    const q = c.req.query("q");
    const label = c.req.query("label");
    const priority = c.req.query("priority");
    const p = c.get("tokenPayload");

    const conds = [eq(issues.repoId, repo.id)];
    if (status === "open" || status === "closed" || status === "archived") conds.push(eq(issues.status, status));
    if (assigned === "me" && p.kind === "agent") conds.push(eq(issues.assignedAgentId, p.agentId));
    if (milestone) conds.push(eq(issues.milestoneId, milestone));
    if (priority) conds.push(eq(issues.priority, priority));
    if (q) conds.push(or(ilike(issues.title, `%${q}%`), ilike(issues.body, `%${q}%`))!);

    const rows = await db.select().from(issues).where(and(...conds)).orderBy(desc(issues.updatedAt)).limit(200);
    const filtered = label ? rows.filter(r => (r.labels as string[]).includes(label)) : rows;
    return c.json({ issues: filtered });
  });

  app.get("/:ns/:repo/issues/:num", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, row.id)).orderBy(asc(issueComments.createdAt));
    // v2 agents-ux: agent actions render like human ones — the UI needs a NAME
    // per comment, not a bare kind. Resolve both kinds in two batched lookups.
    const agentIds = [...new Set(comments.filter(cm => cm.authorKind === "agent").map(cm => cm.authorId))];
    const userIds = [...new Set(comments.filter(cm => cm.authorKind !== "agent").map(cm => cm.authorId))];
    const agentRows = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
    const userRows = userIds.length ? await db.select({ id: users.id, username: users.username, name: users.name }).from(users).where(inArray(users.id, userIds)) : [];
    const nameById = new Map<string, string>([
      ...agentRows.map(r => [r.id, r.name] as const),
      ...userRows.map(r => [r.id, r.username ?? r.name ?? "user"] as const),
    ]);
    const commentsOut = comments.map(cm => ({ ...cm, authorName: nameById.get(cm.authorId) ?? null }));
    const milestone = row.milestoneId ? (await db.select().from(milestones).where(eq(milestones.id, row.milestoneId)).limit(1))[0] ?? null : null;
    // Linked changes (#13) — N:M "this PR fixes this issue".
    const links = await db.select({ id: changes.id, branch: changes.branch, intent: changes.intent, status: changes.status })
      .from(issueChanges).innerJoin(changes, eq(changes.id, issueChanges.changeId))
      .where(eq(issueChanges.issueId, row.id)).orderBy(desc(issueChanges.createdAt));
    return c.json({ issue: row, comments: commentsOut, milestone, links });
  });

  app.post("/:ns/:repo/issues", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as {
      title?: string; body?: string; assignedAgentId?: string; labels?: string[];
      milestoneId?: string | null; priority?: "low" | "normal" | "high" | "urgent";
    };
    if (!body.title) throw new ValidationError("title required");
    // A manually-assigned agent must be able to SEE and WORK this repo — mirror
    // the collaborator-grant guard that automatic routing rules already enforce,
    // else an issue can be assigned to an agent that can't discover or push it.
    if (body.assignedAgentId && !(await agentHasRepoGrant(db, repo.id, body.assignedAgentId))) {
      throw new ValidationError("agent is not a collaborator on this repo");
    }
    // Number allocation is race-safe + serialized per repo (#119) — a concurrent
    // create no longer dies on `issues_repo_num_uniq` with a raw 500.
    const inserted = await insertIssueWithNumber(db, {
      repoId: repo.id,
      title: body.title,
      body: body.body,
      labels: body.labels ?? [],
      assignedAgentId: body.assignedAgentId,
      milestoneId: body.milestoneId ?? null,
      priority: body.priority ?? "normal",
      createdByKind: p.kind === "user" ? "human" : "agent",
      createdById: p.kind === "user" ? p.userId : p.agentId,
    });
    const number = inserted.number;

    // Parse @-mentions in title + body and deliver them (inbox + email).
    {
      const actor = { kind: (p.kind === "user" ? "human" : "agent") as "human" | "agent", id: p.kind === "user" ? p.userId : p.agentId };
      const mentioned = await resolveAndRecordMentions(db, `${body.title}\n${body.body ?? ""}`, {
        repoId: repo.id, sourceKind: "issue", sourceId: inserted.id, author: actor,
      });
      const ns = c.req.param("ns"), repoName = c.req.param("repo");
      await deliverMentions(db, mentioned, {
        repoId: repo.id, repoFullName: `${ns}/${repoName}`,
        link: `/repos/${ns}/${repoName}/issues/${number}`,
        sourceKind: "issue", sourceId: inserted.id, snippet: body.title, actor,
      });
    }

    // Issue routing (N5): auto-assign an unassigned issue per the repo's rules.
    if (!inserted.assignedAgentId) {
      const routed = await applyIssueRouting(db, repo.id, inserted).catch(() => null);
      if (routed) inserted.assignedAgentId = routed;
    }

    await events.publish({ type: "issue.opened", repoId: repo.id, issueNumber: number, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId });
    return c.json({ issue: inserted }, 201);
  });

  app.patch("/:ns/:repo/issues/:num", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const body = await c.req.json().catch(() => ({})) as {
      title?: string; body?: string; status?: "open" | "closed"; assignedAgentId?: string | null;
      labels?: string[]; milestoneId?: string | null; priority?: "low" | "normal" | "high" | "urgent";
    };
    // Same guard as create: a non-null reassignment must point at an agent that
    // holds a collaborator grant on this repo (clearing to null is always fine).
    if (body.assignedAgentId && !(await agentHasRepoGrant(db, repo.id, body.assignedAgentId))) {
      throw new ValidationError("agent is not a collaborator on this repo");
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.body !== undefined) patch.body = body.body;
    if (body.status) patch.status = body.status;
    if (body.assignedAgentId !== undefined) patch.assignedAgentId = body.assignedAgentId;
    if (body.labels !== undefined) patch.labels = body.labels;
    if (body.milestoneId !== undefined) patch.milestoneId = body.milestoneId;
    if (body.priority) patch.priority = body.priority;
    await db.update(issues).set(patch).where(eq(issues.id, row.id));

    // Issue routing (N5): a new label on a still-unassigned issue can route it.
    const effectiveAssignee = body.assignedAgentId !== undefined ? body.assignedAgentId : row.assignedAgentId;
    if (body.labels !== undefined && !effectiveAssignee) {
      await applyIssueRouting(db, repo.id, { id: row.id, labels: body.labels, assignedAgentId: null }).catch(() => null);
    }

    if (body.status === "closed") {
      await events.publish({ type: "issue.closed", repoId: repo.id, issueNumber: number, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId });
    }
    return c.json({ ok: true });
  });

  app.post("/:ns/:repo/issues/:num/comments", async c => {
    const p = c.get("tokenPayload");
    // Posting a comment requires REVIEW access (reviewer/write/admin), matching
    // the change-comment route (comments.ts) — read-only callers on a public
    // repo could otherwise spam comments + fan out unbounded @mention
    // notifications (#117). `access` still feeds handleSlashComment below.
    const { repo, access } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const number = Number(c.req.param("num"));
    const row = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, number))).limit(1))[0];
    if (!row) throw new NotFoundError("issue");
    const body = await c.req.json().catch(() => ({})) as { body?: string };
    if (!body.body) throw new ValidationError("body required");
    const inserted = (await db.insert(issueComments).values({
      issueId: row.id,
      authorKind: p.kind === "user" ? "human" : "agent",
      authorId: p.kind === "user" ? p.userId : p.agentId,
      body: body.body,
    }).returning())[0];

    {
      const actor = { kind: (p.kind === "user" ? "human" : "agent") as "human" | "agent", id: p.kind === "user" ? p.userId : p.agentId };
      const mentioned = await resolveAndRecordMentions(db, body.body, {
        repoId: repo.id, sourceKind: "issue_comment", sourceId: inserted.id, author: actor,
      });
      const ns = c.req.param("ns"), repoName = c.req.param("repo");
      await deliverMentions(db, mentioned, {
        repoId: repo.id, repoFullName: `${ns}/${repoName}`,
        link: `/repos/${ns}/${repoName}/issues/${number}`,
        sourceKind: "issue_comment", sourceId: inserted.id, snippet: body.body, actor,
      });
    }

    await events.publish({ type: "issue.commented", repoId: repo.id, issueNumber: number });

    // v3 P4: a leading slash command in an issue comment points a deployed
    // agent at THIS issue (e.g. "/dev" builds it). Best-effort.
    const workflowRun = await handleSlashComment(db, events, {
      repoId: repo.id, caller: p, access, body: body.body, issueNumber: number,
    });

    return c.json({ comment: inserted, ...(workflowRun ? { workflowRun } : {}) }, 201);
  });

  // Link a change to an issue (#13). Accepts a changeId or a branch name.
  app.post("/:ns/:repo/issues/:num/changes", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const issue = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(c.req.param("num"))))).limit(1))[0];
    if (!issue) throw new NotFoundError("issue");
    const body = await c.req.json().catch(() => ({})) as { changeId?: string; branch?: string };
    const change = body.changeId
      ? (await db.select().from(changes).where(and(eq(changes.id, body.changeId), eq(changes.repoId, repo.id))).limit(1))[0]
      : body.branch
        ? (await db.select().from(changes).where(and(eq(changes.branch, body.branch), eq(changes.repoId, repo.id))).orderBy(desc(changes.updatedAt)).limit(1))[0]
        : undefined;
    if (!change) throw new NotFoundError("change");
    // Idempotent: the unique (issue,change) index makes a re-link a no-op.
    await db.insert(issueChanges).values({ issueId: issue.id, changeId: change.id, repoId: repo.id }).onConflictDoNothing();
    await events.publish({ type: "issue.linked", repoId: repo.id, issueNumber: issue.number });
    return c.json({ ok: true, link: { id: change.id, branch: change.branch, intent: change.intent, status: change.status } }, 201);
  });

  // Unlink a change from an issue (#13).
  app.delete("/:ns/:repo/issues/:num/changes/:changeId", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const issue = (await db.select().from(issues).where(and(eq(issues.repoId, repo.id), eq(issues.number, Number(c.req.param("num"))))).limit(1))[0];
    if (!issue) throw new NotFoundError("issue");
    await db.delete(issueChanges).where(and(eq(issueChanges.issueId, issue.id), eq(issueChanges.changeId, c.req.param("changeId"))));
    return c.json({ ok: true });
  });

  // Issue routing rules (N5) — label → agent auto-assignment. Read = repo read;
  // write = repo write (a routing rule directs work, so it's a governance edit).
  app.get("/:ns/:repo/issue-routing", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    return c.json({ rules: await listIssueRoutingRules(db, repo.id) });
  });
  app.put("/:ns/:repo/issue-routing", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { label?: string; agentId?: string; priority?: number; enabled?: boolean };
    if (!body.label || !body.agentId) throw new ValidationError("label and agentId required");
    try {
      await setIssueRoutingRule(db, repo.id, { label: body.label, agentId: body.agentId, priority: body.priority, enabled: body.enabled });
    } catch (e) { throw new ValidationError((e as Error).message); }
    return c.json({ rules: await listIssueRoutingRules(db, repo.id) });
  });
  app.delete("/:ns/:repo/issue-routing/:label", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await deleteIssueRoutingRule(db, repo.id, decodeURIComponent(c.req.param("label")));
    return c.json({ ok: true });
  });

  return app;
}
