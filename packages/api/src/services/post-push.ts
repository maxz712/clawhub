import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, changes, ciPipelines, ciRuns, issues, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { parseTrailers } from "./trailer-parser.js";
import { extractInlineReviewComments, mergeFocus } from "./focus-parser.js";
import { randomToken } from "./auth.js";

export interface PushedRef {
  ref: string;          // e.g. refs/heads/feature/x
  oldSha: string;       // 40 zeros for create
  newSha: string;       // 40 zeros for delete
}

export async function processPush(params: {
  db: DB;
  git: GitService;
  changeRefs: ChangeRefService;
  events: EventBus;
  namespace: string;
  repoName: string;
  repoId: string;
  defaultBranch: string;
  agentId: string;
  pushedRefs: PushedRef[];
}): Promise<void> {
  const { db, git, changeRefs, events, namespace, repoName, repoId, defaultBranch, agentId, pushedRefs } = params;

  for (const r of pushedRefs) {
    if (!r.ref.startsWith("refs/heads/")) continue;
    const branch = r.ref.slice("refs/heads/".length);
    const deleted = /^0+$/.test(r.newSha);

    if (deleted) {
      await db.delete(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, branch)));
      continue;
    }

    await db.insert(branches).values({ repoId, name: branch, headCommit: r.newSha })
      .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });

    // Default-branch push: no Change row, just fire event.
    if (branch === defaultBranch && !/^0+$/.test(r.oldSha)) {
      await events.publish({ type: "push.default", repoId, actorKind: "agent", actorId: agentId, payload: { branch, sha: r.newSha } });
      continue;
    }

    // Aggregate trailers across the new commits on this branch.
    const range = /^0+$/.test(r.oldSha) ? `${defaultBranch}..${r.newSha}` : `${r.oldSha}..${r.newSha}`;
    let commits: Array<{ sha: string; subject: string; message: string }> = [];
    try { commits = await git.listCommits(namespace, repoName, range, 200); } catch { commits = []; }

    const allTrailers = commits.map(c => parseTrailers(c.message));
    const head = allTrailers[0];
    const intent = head?.intent ?? commits[0]?.subject ?? branch;
    const risk = head?.risk ?? "low";

    // Scope: union of declared scopes, fallback to diff-derived.
    let scope = Array.from(new Set(allTrailers.flatMap(t => t.scope)));
    if (scope.length === 0) {
      try { scope = await git.diffNameOnly(namespace, repoName, defaultBranch, r.newSha); } catch {}
    }

    // Review-Focus from trailers + inline comments in changed files.
    const inline = [];
    for (const p of scope) {
      try {
        const contents = await git.fileAt(namespace, repoName, r.newSha, p);
        if (contents) inline.push(...extractInlineReviewComments(p, contents));
      } catch {}
    }
    const reviewFocus = mergeFocus(allTrailers.flatMap(t => t.reviewFocus), inline);
    const closes = Array.from(new Set(allTrailers.flatMap(t => t.closes)));

    // Trial merge.
    let hasConflicts = false;
    try { hasConflicts = (await git.trialMerge(namespace, repoName, defaultBranch, r.newSha)).conflicts; } catch {}

    const trailers = allTrailers.reduce<Record<string, string[]>>((acc, t) => {
      for (const [k, v] of Object.entries(t.raw)) (acc[k] ??= []).push(...v);
      return acc;
    }, {});

    const existing = await db.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1);
    let changeId: string;
    if (existing[0]) {
      await db.update(changes).set({
        headCommit: r.newSha, intent, risk, scope, reviewFocus, trailers,
        hasConflicts, status: "pending", updatedAt: new Date(),
      }).where(eq(changes.id, existing[0].id));
      changeId = existing[0].id;
    } else {
      const ins = await db.insert(changes).values({
        repoId, branch, headCommit: r.newSha, intent, risk,
        scope, reviewFocus, trailers, hasConflicts, openedByAgentId: agentId,
      }).returning();
      changeId = ins[0].id;
    }

    await changeRefs.set(namespace, repoName, changeId, r.newSha);

    // Link Closes: issues (pending until merge).
    if (closes.length) {
      await db.update(issues).set({ closingChangeId: changeId, updatedAt: new Date() })
        .where(and(eq(issues.repoId, repoId), inArray(issues.number, closes)));
    }

    // Queue CI runs.
    const pipelines = await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repoId), eq(ciPipelines.enabled, true)));
    for (const p of pipelines) {
      await db.insert(ciRuns).values({ repoId, changeId, pipelineId: p.id, runnerToken: randomToken(18) });
    }

    await events.publish({
      type: existing[0] ? "change.updated" : "change.opened",
      repoId, changeId, actorKind: "agent", actorId: agentId,
      payload: { branch, intent, risk, hasConflicts, scope, reviewFocus },
    });
  }
}
