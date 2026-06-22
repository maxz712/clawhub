import { and, eq, desc, inArray, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, ciPipelines, ciRuns, issues, publicActivity, repositories, reviews, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import { evaluateMerge, type MergePolicy, type ReviewBasis } from "./merge-policy.js";
import { agentEarnedAutonomy } from "./agent-autonomy.js";
import { trustedAgentNamesInOrg } from "./org-registry.js";
import type { Risk } from "./trailer-parser.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { withRepoLock } from "./repo-lock.js";
import { isLocal, ShardMap, type ShardEndpoint } from "./shard-map.js";
import type { GitClientPool } from "./git-client.js";
import { log } from "./logger.js";
import { randomToken } from "./auth.js";
import { pipelineTrigger } from "./ci-yaml.js";
import { namespaceNameOf, type NamespaceKind } from "./namespace.js";
import { getAuditLog } from "./audit.js";
import { createNotification, queueEmail } from "./notifications.js";

export type MergeMethod = "merge" | "squash" | "rebase";

export interface BranchProtection {
  requirePullRequest?: boolean;
  requiredApprovals?: number;
  requireCiSuccess?: boolean;
  blockDeletion?: boolean;
  blockForcePush?: boolean;
  allowedMergeMethods?: MergeMethod[];
}

/**
 * Pure branch-protection rule check for the MERGE path (block-force-push /
 * block-deletion live on the push path in post-push.ts). Returns a human reason
 * string when a rule is violated, or null when the merge may proceed. Extracted
 * from mergeLocked so the rules are unit-testable without a full merge.
 *   - allowedMergeMethods: restricts the merge method.
 *   - requireCiSuccess: CI must be success or skipped.
 *   - requirePullRequest: the change must come from a SEPARATE branch (its head
 *     branch is not the protected/default branch).
 *   - requiredApprovals: at least N distinct approving reviewers (caller counts).
 */
export function branchProtectionViolation(
  protection: BranchProtection | null | undefined,
  ctx: { method: MergeMethod; ciStatus: string; changeBranch: string; defaultBranch: string; approverCount: number },
): string | null {
  if (!protection) return null;
  if (protection.allowedMergeMethods?.length && !protection.allowedMergeMethods.includes(ctx.method)) {
    return `branch protection disallows ${ctx.method}`;
  }
  if (protection.requireCiSuccess && ctx.ciStatus !== "success" && ctx.ciStatus !== "skipped") {
    return `branch protection requires CI success (got ${ctx.ciStatus})`;
  }
  if (protection.requirePullRequest && ctx.changeBranch === ctx.defaultBranch) {
    return "branch protection requires a pull request — changes must come from a separate branch";
  }
  if (protection.requiredApprovals && protection.requiredApprovals > 0 && ctx.approverCount < protection.requiredApprovals) {
    return `branch protection requires ${protection.requiredApprovals} approving review${protection.requiredApprovals === 1 ? "" : "s"} (got ${ctx.approverCount})`;
  }
  return null;
}

export class ChangeService {
  private shardMap?: ShardMap;
  private gitClients?: GitClientPool;

  constructor(private db: DB, private git: GitService, private events: EventBus) {}

  /** Optionally wire shard-aware merge. Falls back to local `simple-git` ops when shard is `local://inprocess`. */
  setShardRouting(shardMap: ShardMap, clients: GitClientPool): void {
    this.shardMap = shardMap;
    this.gitClients = clients;
  }

  private async shardFor(repoId: string): Promise<ShardEndpoint | null> {
    if (!this.shardMap) return null;
    return this.shardMap.primaryFor(repoId);
  }

  async get(changeId: string) {
    const r = await this.db.select().from(changes).where(eq(changes.id, changeId)).limit(1);
    if (!r[0]) throw new NotFoundError("change");
    return r[0];
  }

  async listByRepo(repoId: string, limit = 50) {
    return this.db.select().from(changes).where(eq(changes.repoId, repoId)).orderBy(desc(changes.updatedAt)).limit(limit);
  }

  /**
   * Resolve the authoring identity for a change so the UI can show WHO authored
   * it: the agent's readable name plus the user who owns that agent (the human
   * who claimed it, else its service user). Routes spread this onto the change
   * payload as `openedByAgentName` + `openedByOwnerUserId`.
   */
  async authorInfo(openedByAgentId: string): Promise<{ openedByAgentName: string | null; openedByOwnerUserId: string | null }> {
    const a = (await this.db.select().from(agents).where(eq(agents.id, openedByAgentId)).limit(1))[0];
    return {
      openedByAgentName: a?.name ?? null,
      openedByOwnerUserId: a?.associatedUserId ?? a?.serviceUserId ?? null,
    };
  }

  async evaluate(changeId: string) {
    const change = await this.get(changeId);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");
    let policy = repo.mergePolicy as MergePolicy;
    // Earned autonomy: a proven agent (opted-in role + track record + quality
    // clears the bar) may self-approve its OWN work — but only at LOW effective
    // risk. Sensitive paths + medium+ still force a human in evaluateMerge, so
    // this never bypasses those gates; it only lifts the self-review block for a
    // trusted agent on safe changes. (null computedRisk is treated as high.)
    const lowRisk = change.risk === "low" && ((change.computedRisk as Risk | null) ?? "high") === "low";
    if (lowRisk && !policy.allowSelfReview && await agentEarnedAutonomy(this.db, change.openedByAgentId)) {
      policy = { ...policy, allowSelfReview: true };
    }
    // Org-registry trusted tier as a merge lever: for an ORG repo, agents the
    // org enrolled at the `trusted` tier count like the per-repo `trustedAgents`
    // list — their review can substitute for a general approval on low-risk
    // changes (evaluateMerge). This makes the registry's top tier an actual
    // merge signal, not just a badge. (namespaceId IS the orgId for org repos.)
    if (repo.namespaceType === "org") {
      const registryTrusted = await trustedAgentNamesInOrg(this.db, repo.namespaceId);
      if (registryTrusted.length) {
        policy = { ...policy, trustedAgents: Array.from(new Set([...(policy.trustedAgents ?? []), ...registryTrusted])) };
      }
    }
    const revs = await this.db.select().from(reviews).where(and(eq(reviews.changeId, changeId), isNull(reviews.supersededAt)));
    const reviewerAgentIds = Array.from(new Set(revs.filter(r => r.reviewerKind === "agent").map(r => r.reviewerId)));
    const agentLookup: Record<string, string> = {};
    if (reviewerAgentIds.length) {
      const rows = await this.db.select().from(agents).where(inArray(agents.id, reviewerAgentIds));
      for (const a of rows) agentLookup[a.id] = a.name;
    }
    // Separation of duties: resolve the user who OWNS the authoring agent so the
    // SoD gate can exclude that user's own approval as the independent reviewer.
    // (associated_user_id when a human claimed the agent, else the service user
    // that owns a headless agent's repos.) Default ON for org repos, OFF for
    // user/solo repos — passed via namespaceType.
    const openedByOwnerUserId = await this.agentOwnerUserId(change.openedByAgentId);
    return evaluateMerge({
      policy,
      risk: change.risk,
      // Fail closed: a Change predating risk computation (null) has unknown
      // true risk — treat as high so it can't slip through on a stale
      // agent-declared `Risk: low`. Every current push sets computedRisk.
      computedRisk: (change.computedRisk as Risk | null) ?? "high",
      scope: change.scope as string[],
      changedPaths: change.changedPaths as string[],
      openedByAgentId: change.openedByAgentId,
      openedByOwnerUserId,
      namespaceType: repo.namespaceType as "user" | "org" | "agent",
      reviews: revs.map(r => ({
        reviewerKind: r.reviewerKind,
        reviewerId: r.reviewerId,
        verdict: r.verdict,
        basis: (r.basis as ReviewBasis | undefined) ?? "code",
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

    // Branch protection check on the destination default branch. The pure rule
    // logic lives in `branchProtectionViolation` (unit-tested); here we only
    // gather the inputs. `requiredApprovals` counts DISTINCT approving reviewers
    // (a reviewer approving twice counts once) — loaded only when that rule is on.
    const b = (await this.db.select().from(branches).where(and(eq(branches.repoId, repo.id), eq(branches.name, repo.defaultBranch))).limit(1))[0];
    const protection = (b?.protection as BranchProtection | null) ?? null;
    let approverCount = 0;
    if (protection?.requiredApprovals && protection.requiredApprovals > 0) {
      // Exclude the AUTHOR (the opening agent + its owning user) so the floor
      // measures INDEPENDENT approvals — mirroring evaluateMerge's author
      // exclusion. Otherwise an opted-in self-reviewing agent could satisfy
      // requiredApprovals by approving its own change.
      const opener = (await this.db.select().from(agents).where(eq(agents.id, change.openedByAgentId)).limit(1))[0];
      const authorIds = new Set<string>([change.openedByAgentId]);
      if (opener?.associatedUserId) authorIds.add(opener.associatedUserId);
      if (opener?.serviceUserId) authorIds.add(opener.serviceUserId);
      const revs = await this.db.select().from(reviews).where(and(eq(reviews.changeId, changeId), isNull(reviews.supersededAt)));
      approverCount = new Set(revs.filter(r => r.verdict === "approve" && !authorIds.has(r.reviewerId)).map(r => r.reviewerId)).size;
    }
    const violation = branchProtectionViolation(protection, {
      method, ciStatus: change.ciStatus, changeBranch: change.branch, defaultBranch: repo.defaultBranch, approverCount,
    });
    if (violation) throw new ForbiddenError(violation, "branch_protection");

    const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
    const actor = await this.actorIdentity(by);
    const openerName = await this.openerName(change.openedByAgentId);
    const msgMerge = `Merge change: ${change.intent}\n\nAgent: ${openerName}\nChange-Id: ${changeId}\n`;
    const msgSquash = `${change.intent}\n\nAgent: ${openerName}\nChange-Id: ${changeId}\n`;

    // If the repo lives on a remote shard, ask the shard to perform the merge.
    // The shard returns the merge commit SHA; we then write the canonical
    // ref-log entry below (Phase 4 WAL). When the repo is local, fall back to
    // the existing in-process simple-git path.
    let mergeCommit: string;
    const shard = await this.shardFor(repo.id);
    if (shard && !isLocal(shard) && this.gitClients) {
      try {
        const client = this.gitClients.rpc(shard);
        const out = await client.mergeInto({
          namespace: ns,
          name: repo.name,
          baseBranch: repo.defaultBranch,
          headCommit: change.headCommit,
          authorName: actor.name,
          authorEmail: actor.email,
          message: method === "merge" ? msgMerge : msgSquash,
          method,
        });
        mergeCommit = out.mergeCommit;
      } catch (e) {
        log("warn", "shard_merge_failed_fallback_local", { err: (e as Error).message, repoId: repo.id });
        mergeCommit = await this.localMerge(method, ns, repo.name, repo.defaultBranch, change.headCommit, actor, msgMerge, msgSquash);
      }
    } else {
      mergeCommit = await this.localMerge(method, ns, repo.name, repo.defaultBranch, change.headCommit, actor, msgMerge, msgSquash);
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

    // Audit trail: who merged, with which method, at what effective risk, and
    // which approval basis satisfied the gate (separation-of-duties signal too).
    // Non-fatal — AuditLog.record() swallows its own errors, but guard the await
    // anyway so a failed audit write can never abort a completed merge.
    try {
      const effectiveRisk = this.effectiveRisk(change.risk as Risk, change.computedRisk as Risk | null);
      await getAuditLog(this.db).record({
        repoId: repo.id,
        actorKind: by.kind,
        actorId: by.id,
        action: "change.merged",
        category: "merge",
        metadata: {
          changeId,
          mergeMethod: method,
          mergeCommit,
          effectiveRisk,
          openedByAgentId: change.openedByAgentId,
          codeReviewRequired: decision.codeReviewRequired ?? false,
          independentApproverRequired: decision.independentApproverRequired ?? false,
          satisfiedBasis: decision.satisfiedBasis ?? null,
        },
      });
    } catch { /* audit must never break the merge */ }

    // Merge-triggered pipelines (`on: merge` in the yaml) — the deploy hook.
    // Queued at the merge commit so the runner builds exactly what landed.
    const mergePipelines = (await this.db.select().from(ciPipelines)
      .where(and(eq(ciPipelines.repoId, repo.id), eq(ciPipelines.enabled, true))))
      .filter(p => pipelineTrigger(p.yaml) === "merge");
    for (const p of mergePipelines) {
      const runnerToken = randomToken(18);
      const run = (await this.db.insert(ciRuns).values({ repoId: repo.id, changeId, pipelineId: p.id, runnerToken, origin: "merge", triggerDepth: 0, commit: mergeCommit }).returning())[0];
      await this.events.publish({
        type: "ci.run.queued", repoId: repo.id, changeId, actorKind: by.kind, actorId: by.id,
        payload: { runId: run.id, repoNs: ns, repoName: repo.name, commit: mergeCommit, pipelineYaml: p.yaml, runnerToken },
      });
    }

    return { mergeCommit, method };
  }

  private async localMerge(
    method: MergeMethod,
    ns: string,
    repoName: string,
    defaultBranch: string,
    headCommit: string,
    actor: { name: string; email: string },
    msgMerge: string,
    msgSquash: string,
  ): Promise<string> {
    try {
      if (method === "merge")  return await this.git.mergeInto(ns, repoName, defaultBranch, headCommit, actor.name, actor.email, msgMerge);
      if (method === "squash") return await this.git.squashInto(ns, repoName, defaultBranch, headCommit, actor.name, actor.email, msgSquash);
      return await this.git.rebaseInto(ns, repoName, defaultBranch, headCommit, actor.name, actor.email);
    } finally {
      // Server-side merges write objects via commit-tree, which never triggers
      // receive-pack's auto-gc — without this, loose objects accumulate forever.
      void this.git.gcAuto(ns, repoName);
    }
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

    // Audit trail: who rolled back which merged change. Non-fatal.
    try {
      await getAuditLog(this.db).record({
        repoId: repo.id,
        actorKind: by.kind,
        actorId: by.id,
        action: "change.rolled_back",
        category: "change",
        metadata: {
          changeId,
          mergeCommit: change.mergeCommit ?? null,
          openedByAgentId: change.openedByAgentId,
        },
      });
    } catch { /* audit must never break the rollback */ }
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

  /**
   * Undo a mis-clicked "request changes": supersede the change's request_changes
   * verdicts (they stay for history but no longer block the merge gate — evaluate
   * filters supersededAt) and return the change to `pending` for re-review. Only
   * valid from `changes_requested`.
   */
  async reopen(changeId: string, by: { kind: "agent" | "human"; id: string }): Promise<void> {
    const change = await this.get(changeId);
    if (change.status !== "changes_requested") {
      throw new ConflictError(`cannot reopen a change in status ${change.status}`);
    }
    await this.db.update(reviews)
      .set({ supersededAt: new Date() })
      .where(and(eq(reviews.changeId, changeId), eq(reviews.verdict, "request_changes"), isNull(reviews.supersededAt)));
    await this.db.update(changes).set({ status: "pending", updatedAt: new Date() }).where(eq(changes.id, changeId));
    await this.events.publish({ type: "change.updated", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id, payload: { reopened: true } });
  }

  async requestReviewers(
    changeId: string,
    reviewers: Array<{ kind: "agent" | "human"; id: string }>,
    requestedByUserId?: string,
  ): Promise<void> {
    // Read the prior reviewer set BEFORE overwriting so we only deliver to the
    // NEWLY-added humans — re-submitting an overlapping set (e.g. adding one
    // reviewer) must not re-ping/re-email everyone already requested.
    const change = await this.get(changeId);
    const prevHumanIds = new Set(
      ((change.requestedReviewers as Array<{ kind: string; id: string }> | null) ?? [])
        .filter(r => r.kind === "human").map(r => r.id),
    );
    await this.db.update(changes).set({
      requestedReviewers: reviewers,
      updatedAt: new Date(),
    }).where(eq(changes.id, changeId));
    await this.events.publish({
      type: "change.review_requested",
      repoId: change.repoId,
      changeId,
      payload: { reviewers },
    });
    // Deliver to each NEWLY-added HUMAN reviewer: a durable inbox notification +
    // an email (gated by their emailOnReviewRequested pref). Agent reviewers are
    // driven by events/the merge loop, not the human inbox. Dedupe within the
    // call (Set), drop ids already requested, and never notify the requester
    // about their own request — mirroring the mention path's self-skip.
    const newHumanIds = [...new Set(reviewers.filter(r => r.kind === "human").map(r => r.id))]
      .filter(id => !prevHumanIds.has(id) && id !== requestedByUserId);
    if (newHumanIds.length) {
      // Only deliver to ids that are real users — a caller-supplied non-user id
      // would otherwise blow up the notifications FK insert and fail the call.
      const validIds = new Set(
        (await this.db.select({ id: users.id }).from(users)
          .where(inArray(users.id, newHumanIds))).map(u => u.id),
      );
      const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
      const ns = repo ? await namespaceNameOf(this.db, repo.namespaceType, repo.namespaceId) : null;
      const repoFullName = repo ? (ns ? `${ns}/${repo.name}` : repo.name) : "a repo";
      const link = repo && ns ? `/repos/${ns}/${repo.name}/changes/${changeId}` : null;
      const title = `Review requested on ${repoFullName}`;
      const body = change.intent || null;
      for (const id of newHumanIds) {
        if (!validIds.has(id)) continue;
        await createNotification(this.db, {
          userId: id, kind: "review_requested", title, body, link,
          repoId: change.repoId, sourceKind: "change", sourceId: changeId,
        });
        await queueEmail(this.db, id, title, `${body ?? ""}${link ? `\n\nView: ${link}` : ""}`.trim(), "emailOnReviewRequested");
      }
    }
  }

  private async namespaceName(kind: NamespaceKind, id: string): Promise<string> {
    const name = await namespaceNameOf(this.db, kind, id);
    if (!name) throw new NotFoundError(`${kind} namespace`);
    return name;
  }

  private async openerName(agentId: string): Promise<string> {
    const a = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    return a[0]?.name ?? "unknown";
  }

  /**
   * The user who owns the authoring agent, for the separation-of-duties gate:
   * the human who claimed it (`associatedUserId`) if any, else the service user
   * that owns a headless agent's repos (`serviceUserId`). Null when neither is
   * set — the SoD gate then can't exclude anyone (falls open, never wrongly
   * blocks).
   */
  private async agentOwnerUserId(agentId: string): Promise<string | null> {
    const a = (await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
    return a?.associatedUserId ?? a?.serviceUserId ?? null;
  }

  /** Effective risk = max(declared, computed); a null computed (pre-migration) is treated as high, matching evaluate(). */
  private effectiveRisk(declared: Risk, computed: Risk | null): Risk {
    const order: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const c: Risk = computed ?? "high";
    return order[c] > order[declared] ? c : declared;
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
