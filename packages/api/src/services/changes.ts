import { and, eq, desc } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, ciRuns, issues, publicActivity, repositories, reviews } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import { evaluateMerge, type MergePolicy } from "./merge-policy.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { withRepoLock } from "./repo-lock.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface BranchProtection {
  requirePullRequest?: boolean;
  requiredApprovals?: number;
  requireCiSuccess?: boolean;
  blockDeletion?: boolean;
  blockForcePush?: boolean;
  allowedMergeMethods?: MergeMethod[];
}

export class ChangeService {
  constructor(private db: DB, private git: GitService, private events: EventBus) {}

  async get(changeId: string) {
    const r = await this.db.select().from(changes).where(eq(changes.id, changeId)).limit(1);
    if (!r[0]) throw new NotFoundError("change");
    return r[0];
  }

  async listByRepo(repoId: string, limit = 50) {
    return this.db.select().from(changes).where(eq(changes.repoId, repoId)).orderBy(desc(changes.updatedAt)).limit(limit);
  }

  async evaluate(changeId: string) {
    const change = await this.get(changeId);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");
    const policy = repo.mergePolicy as MergePolicy;
    const revs = await this.db.select().from(reviews).where(eq(reviews.changeId, changeId));
    const reviewerAgentIds = revs.filter(r => r.reviewerKind === "agent").map(r => r.reviewerId);
    const agentLookup: Record<string, string> = {};
    if (reviewerAgentIds.length) {
      const rows = await this.db.select().from(agents).where(
        reviewerAgentIds.length === 1
          ? eq(agents.id, reviewerAgentIds[0])
          : (undefined as never)
      );
      // Simple single-id case; for general use, caller can pre-resolve.
      for (const a of rows) agentLookup[a.id] = a.name;
    }
    return evaluateMerge({
      policy,
      risk: change.risk,
      scope: change.scope as string[],
      openedByAgentId: change.openedByAgentId,
      reviews: revs.map(r => ({
        reviewerKind: r.reviewerKind,
        reviewerId: r.reviewerId,
        verdict: r.verdict,
        agentName: agentLookup[r.reviewerId],
      })),
      ciStatus: change.ciStatus,
    });
  }

  async merge(changeId: string, by: { kind: "agent" | "human"; id: string }, method: MergeMethod = "merge"): Promise<{ mergeCommit: string; method: MergeMethod }> {
    const initial = await this.get(changeId);
    return withRepoLock(initial.repoId, () => this.mergeLocked(changeId, by, method), { kind: "merge", ttlMs: 60_000, waitMs: 10_000 });
  }

  private async mergeLocked(changeId: string, by: { kind: "agent" | "human"; id: string }, method: MergeMethod): Promise<{ mergeCommit: string; method: MergeMethod }> {
    const change = await this.get(changeId);
    if (change.isDraft) throw new ConflictError("draft changes cannot be merged");
    if (change.status === "merged") throw new ConflictError("already merged");
    if (change.status === "rolled_back") throw new ConflictError("change rolled back");
    if (change.hasConflicts) throw new ConflictError("change has merge conflicts");

    const decision = await this.evaluate(changeId);
    if (!decision.mergeable) throw new ForbiddenError(`merge blocked: ${decision.reason}`, "merge_blocked");

    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");

    const policy = repo.mergePolicy as MergePolicy & { allowedMergeMethods?: MergeMethod[]; defaultMergeMethod?: MergeMethod };
    const allowed = policy.allowedMergeMethods?.length ? policy.allowedMergeMethods : ["merge", "squash", "rebase"];
    if (!allowed.includes(method)) {
      throw new ForbiddenError(`merge method ${method} not allowed (allowed: ${allowed.join(", ")})`, "merge_method_not_allowed");
    }

    // Branch protection check on destination default branch.
    const b = (await this.db.select().from(branches).where(and(eq(branches.repoId, repo.id), eq(branches.name, repo.defaultBranch))).limit(1))[0];
    const protection = (b?.protection as BranchProtection | null) ?? null;
    if (protection?.allowedMergeMethods?.length && !protection.allowedMergeMethods.includes(method)) {
      throw new ForbiddenError(`branch protection disallows ${method}`, "branch_protection");
    }
    if (protection?.requireCiSuccess && change.ciStatus !== "success" && change.ciStatus !== "skipped") {
      throw new ForbiddenError(`branch protection requires CI success (got ${change.ciStatus})`, "branch_protection");
    }

    const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
    const actor = await this.actorIdentity(by);
    const openerName = await this.openerName(change.openedByAgentId);
    const msgMerge = `Merge change: ${change.intent}\n\nAgent: ${openerName}\nChange-Id: ${changeId}\n`;
    const msgSquash = `${change.intent}\n\nAgent: ${openerName}\nChange-Id: ${changeId}\n`;

    let mergeCommit: string;
    if (method === "merge") {
      mergeCommit = await this.git.mergeInto(ns, repo.name, repo.defaultBranch, change.headCommit, actor.name, actor.email, msgMerge);
    } else if (method === "squash") {
      mergeCommit = await this.git.squashInto(ns, repo.name, repo.defaultBranch, change.headCommit, actor.name, actor.email, msgSquash);
    } else {
      mergeCommit = await this.git.rebaseInto(ns, repo.name, repo.defaultBranch, change.headCommit, actor.name, actor.email);
    }

    await this.db.update(changes).set({
      status: "merged",
      mergedAt: new Date(),
      mergedBy: by.id,
      mergeMethod: method,
      mergeCommit,
      updatedAt: new Date(),
    }).where(eq(changes.id, changeId));

    // Auto-close Closes: issues.
    await this.db.update(issues).set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(issues.repoId, change.repoId), eq(issues.closingChangeId, changeId)));

    // Public activity (if public repo).
    if (repo.isPublic) {
      await this.db.insert(publicActivity).values({
        repoId: repo.id,
        agentId: change.openedByAgentId,
        kind: "change.merged",
        changeId,
        summary: change.intent,
      });
    }

    await this.events.publish({
      type: "change.merged",
      repoId: change.repoId,
      changeId,
      actorKind: by.kind,
      actorId: by.id,
      payload: { method, mergeCommit },
    });

    return { mergeCommit, method };
  }

  async rollback(changeId: string, by: { kind: "agent" | "human"; id: string }): Promise<void> {
    const change = await this.get(changeId);
    if (change.status !== "merged") throw new ValidationError("only merged changes can be rolled back");

    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");

    if (change.mergeCommit) {
      try {
        const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
        const actor = await this.actorIdentity(by);
        const msg = `Revert merge of change: ${change.intent}\n\nReverts: ${change.mergeCommit}\nChange-Id: ${changeId}\n`;
        // Create a revert commit on top of the default branch using the tree from the pre-merge parent.
        const g = this.git.open(ns, repo.name).env({
          GIT_AUTHOR_NAME: actor.name, GIT_AUTHOR_EMAIL: actor.email,
          GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email,
        });
        const baseSha = (await g.revparse([repo.defaultBranch])).trim();
        const prevSha = (await g.revparse([`${change.mergeCommit}^1`])).trim();
        const prevTree = (await g.revparse([`${prevSha}^{tree}`])).trim();
        const revertCommit = (await g.raw(["commit-tree", prevTree, "-p", baseSha, "-m", msg])).trim();
        await g.raw(["update-ref", `refs/heads/${repo.defaultBranch}`, revertCommit, baseSha]);
      } catch {
        // Best-effort: we still mark the change rolled back in DB.
      }
    }

    await this.db.update(changes).set({ status: "rolled_back", updatedAt: new Date() }).where(eq(changes.id, changeId));
    await this.events.publish({ type: "change.rolled_back", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id });
  }

  async markDraft(changeId: string, draft: boolean): Promise<void> {
    const change = await this.get(changeId);
    if (change.status === "merged" || change.status === "rolled_back") throw new ConflictError("cannot change draft state of closed change");
    await this.db.update(changes).set({
      isDraft: draft,
      status: draft ? "draft" : "pending",
      updatedAt: new Date(),
    }).where(eq(changes.id, changeId));
    await this.events.publish({ type: draft ? "change.drafted" : "change.ready", repoId: change.repoId, changeId });
  }

  async requestReviewers(changeId: string, reviewers: Array<{ kind: "agent" | "human"; id: string }>): Promise<void> {
    await this.db.update(changes).set({
      requestedReviewers: reviewers,
      updatedAt: new Date(),
    }).where(eq(changes.id, changeId));
    const change = await this.get(changeId);
    await this.events.publish({
      type: "change.review_requested",
      repoId: change.repoId,
      changeId,
      payload: { reviewers },
    });
  }

  private async namespaceName(kind: "agent" | "org", id: string): Promise<string> {
    if (kind === "agent") {
      const a = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
      if (!a[0]) throw new NotFoundError("agent namespace");
      return a[0].name;
    }
    const { organizations } = await import("../models/schema.js");
    const o = await this.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    if (!o[0]) throw new NotFoundError("org namespace");
    return o[0].name;
  }

  private async openerName(agentId: string): Promise<string> {
    const a = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    return a[0]?.name ?? "unknown";
  }

  private async actorIdentity(by: { kind: "agent" | "human"; id: string }): Promise<{ name: string; email: string }> {
    if (by.kind === "agent") {
      const a = await this.db.select().from(agents).where(eq(agents.id, by.id)).limit(1);
      if (!a[0]) throw new NotFoundError("agent");
      return { name: a[0].gitAuthorName, email: a[0].gitAuthorEmail };
    }
    const { users } = await import("../models/schema.js");
    const u = await this.db.select().from(users).where(eq(users.id, by.id)).limit(1);
    if (!u[0]) throw new NotFoundError("user");
    return { name: u[0].name ?? u[0].email, email: u[0].email };
  }
}
