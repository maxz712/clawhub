import { and, eq, desc } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, ciRuns, issues, repositories, reviews } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import { evaluateMerge, type MergePolicy } from "./merge-policy.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";

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

  async merge(changeId: string, by: { kind: "agent" | "human"; id: string }): Promise<void> {
    const change = await this.get(changeId);
    if (change.status === "merged") throw new ConflictError("already merged");
    if (change.status === "rolled_back") throw new ConflictError("change rolled back");
    if (change.hasConflicts) throw new ConflictError("change has merge conflicts");

    const decision = await this.evaluate(changeId);
    if (!decision.mergeable) throw new ForbiddenError(`merge blocked: ${decision.reason}`, "merge_blocked");

    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");

    const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
    const actor = await this.actorIdentity(by);
    const msg = `Merge change: ${change.intent}\n\nAgent: ${await this.openerName(change.openedByAgentId)}\nChange-Id: ${changeId}\n`;

    await this.git.mergeInto(ns, repo.name, repo.defaultBranch, change.headCommit, actor.name, actor.email, msg);

    await this.db.update(changes).set({ status: "merged", updatedAt: new Date() }).where(eq(changes.id, changeId));

    // Auto-close Closes: issues.
    await this.db.update(issues).set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(issues.repoId, change.repoId), eq(issues.closingChangeId, changeId)));

    await this.events.publish({ type: "change.merged", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id });
  }

  async rollback(changeId: string): Promise<void> {
    const change = await this.get(changeId);
    if (change.status !== "merged") throw new ValidationError("only merged changes can be rolled back");
    await this.db.update(changes).set({ status: "rolled_back", updatedAt: new Date() }).where(eq(changes.id, changeId));
    await this.events.publish({ type: "change.rolled_back", repoId: change.repoId, changeId });
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
