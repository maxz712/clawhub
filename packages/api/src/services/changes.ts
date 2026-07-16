import { and, eq, desc, inArray, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, ciPipelines, ciRuns, issues, publicActivity, repositories, reviews, standingAgents, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import { evaluateMerge, normalizeMergePolicy, type MergePolicy, type ReviewBasis } from "./merge-policy.js";
import { loadVerifiedAttestation } from "./verification.js";
import { cancelChangeRuns } from "./run-staleness.js";
import { ciSchedulingStamp } from "./job-scheduling.js";
import type { MergeQueue } from "./merge-queue.js";
import { trustedAgentNamesInOrg } from "./org-registry.js";
import type { Risk } from "./trailer-parser.js";
import { ConflictError, ForbiddenError, GitError, NotFoundError, ValidationError } from "./errors.js";
import { repoAccessFor } from "./repo-access.js";
import type { TokenPayload } from "./auth.js";
import { withRepoLock } from "./repo-lock.js";
import { isLocal, ShardMap, type ShardEndpoint } from "./shard-map.js";
import type { GitClientPool } from "./git-client.js";
import { log } from "./logger.js";
import { randomToken } from "./auth.js";
import { pipelineTrigger, parsePipelineTrigger } from "./ci-yaml.js";
import { syncRepoPipelines } from "./ci.js";
import { recomputeChangeCiStatus } from "./ci-runner.js";
import { resolveCiExecution } from "./ci-host-exec.js";
import { captureChangeMerged, captureRollback } from "./memory-capture.js";
import { namespaceNameOf, type NamespaceKind } from "./namespace.js";
import { getAuditLog } from "./audit.js";
import { createNotification, notifyChangeMerged, notifyChangeRolledBack, queueEmail } from "./notifications.js";

export type MergeMethod = "merge" | "squash" | "rebase";

/** Max length of a human-edited Change description (`intent`). */
export const MAX_INTENT_LEN = 10_000;

/**
 * Validate a human-supplied Change description edit. Pure (no DB) so it is
 * unit-testable in isolation and reusable at the route boundary. Returns the
 * trimmed, accepted intent or throws a ValidationError — trimmed non-empty,
 * at most MAX_INTENT_LEN characters.
 */
export function validateIntent(intent: unknown): string {
  if (typeof intent !== "string") throw new ValidationError("intent must be a string");
  const trimmed = intent.trim();
  if (!trimmed) throw new ValidationError("intent must not be empty");
  if (trimmed.length > MAX_INTENT_LEN) throw new ValidationError(`intent must be at most ${MAX_INTENT_LEN} characters`);
  return trimmed;
}

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

  constructor(private db: DB, private git: GitService, private events: EventBus, private mergeQueue?: MergeQueue) {}

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
   * it. A Change is opened by an agent OR a human user. For an agent author we
   * return the agent's name + its owning user (the human who claimed it, else its
   * service user). For a human author we return the human's handle and treat them
   * as their own owner (for separation-of-duties display). Routes spread this
   * onto the change payload as `openedByAgentName` / `openedByUserName`.
   */
  async authorInfo(change: { openedByAgentId: string | null; openedByUserId: string | null }): Promise<{
    openedByAgentName: string | null;
    openedByUserName: string | null;
    openedByOwnerUserId: string | null;
  }> {
    if (change.openedByUserId) {
      const u = (await this.db.select().from(users).where(eq(users.id, change.openedByUserId)).limit(1))[0];
      return {
        openedByAgentName: null,
        openedByUserName: u?.username ?? u?.name ?? u?.email ?? null,
        openedByOwnerUserId: change.openedByUserId,
      };
    }
    const a = change.openedByAgentId
      ? (await this.db.select().from(agents).where(eq(agents.id, change.openedByAgentId)).limit(1))[0]
      : undefined;
    return {
      openedByAgentName: a?.name ?? null,
      openedByUserName: null,
      openedByOwnerUserId: a?.associatedUserId ?? a?.serviceUserId ?? null,
    };
  }

  /** Batch-enrich change rows with author display fields, one query per kind.
   *  Used by list endpoints so each row shows who opened it. */
  async withAuthors<T extends { openedByAgentId: string | null; openedByUserId: string | null }>(
    rows: T[],
  ): Promise<Array<T & { openedByAgentName: string | null; openedByUserName: string | null }>> {
    const agentIds = [...new Set(rows.map(r => r.openedByAgentId).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map(r => r.openedByUserId).filter((x): x is string => !!x))];
    const agentName = new Map<string, string>();
    const userName = new Map<string, string>();
    if (agentIds.length) {
      for (const a of await this.db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))) {
        agentName.set(a.id, a.name);
      }
    }
    if (userIds.length) {
      for (const u of await this.db.select({ id: users.id, username: users.username, name: users.name, email: users.email }).from(users).where(inArray(users.id, userIds))) {
        userName.set(u.id, u.username ?? u.name ?? u.email);
      }
    }
    return rows.map(r => ({
      ...r,
      openedByAgentName: r.openedByAgentId ? agentName.get(r.openedByAgentId) ?? null : null,
      openedByUserName: r.openedByUserId ? userName.get(r.openedByUserId) ?? null : null,
    }));
  }

  async evaluate(changeId: string) {
    // Recompute head-scoped CI status before reading it — never trust the stored
    // column stale. A change poisoned by an old-head/orphaned run self-heals here;
    // a head-advanced change reads fresh 'pending' instead of a prior head's
    // 'success'. Idempotent + cheap; also fires on the under-lock re-check (merge).
    await recomputeChangeCiStatus(this.db, changeId);
    const change = await this.get(changeId);
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");
    let policy = repo.mergePolicy as MergePolicy;
    // v3 uniform merge rights: the earned-autonomy self-review lift is RETIRED
    // as a merge-rights mechanism — merge access is role-based (change:merge,
    // requireMergeRights) and the policy gate below is evaluated identically
    // for humans and agents. agent-autonomy.ts remains for fleet quality/trust
    // reporting only.
    // Solo-human ergonomics: on a USER (personal) repo, a human author owns their
    // own work — let their own approval satisfy the gate so a solo dev isn't
    // blocked waiting for a second human who doesn't exist. This is the persona-1
    // flow the solo-mode preset encodes, and it matches the documented policy
    // ("medium+ requires a human; high/critical or sensitive require a human who
    // reviewed the CODE") — for a personal repo the author IS that human.
    // Deliberately narrow, and it never weakens the code-review backstop:
    //   - ORG repos are untouched (team separation-of-duties stays intact);
    //   - only HUMAN-authored changes (agents never get this — see above);
    //   - evaluateMerge STILL enforces codeReviewRequiredAtRisk + the sensitive-
    //     path baseline, so at high/sensitive the author's approval only counts
    //     with basis code/both. SoD is simply off on a personal repo.
    // (Previously gated on `lowRisk`, which left a solo user permanently unable to
    // merge their OWN first medium-risk or sensitive-path change — a migration, an
    // auth/ module, a deploy/ file — with no second human to ask.)
    if (change.openedByUserId && repo.namespaceType === "user" && !policy.allowSelfReview) {
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
    // Advisory reviews (the native platform reviewer, M4) are excluded from the
    // merge gate: a machine opinion informs but never satisfies an approval slot.
    const revs = await this.db.select().from(reviews).where(and(eq(reviews.changeId, changeId), isNull(reviews.supersededAt), eq(reviews.advisory, false)));
    const reviewerAgentIds = Array.from(new Set(revs.filter(r => r.reviewerKind === "agent").map(r => r.reviewerId)));
    const agentLookup: Record<string, string> = {};
    if (reviewerAgentIds.length) {
      const rows = await this.db.select().from(agents).where(inArray(agents.id, reviewerAgentIds));
      for (const a of rows) agentLookup[a.id] = a.name;
    }
    // Separation of duties: resolve the user who counts as the change's AUTHOR
    // for the SoD gate. For an agent author that's the user who owns the agent
    // (the human who claimed it, else its service user). For a HUMAN author it's
    // the human themselves — their own approval cannot be the independent
    // reviewer of their own change. Default ON for org repos, OFF for user/solo
    // repos — passed via namespaceType.
    const openedByOwnerUserId = change.openedByUserId
      ?? (change.openedByAgentId ? await this.agentOwnerUserId(change.openedByAgentId) : null);
    // Verified autonomy: load a server-validated attestation pinned to the
    // change's CURRENT head. A new push moves the head → a prior attestation no
    // longer matches → it's stale and ignored. Loaded only when the policy opts
    // in (cheap short-circuit); evaluateMerge applies the risk/path/floor guards.
    const verifiedAttestation = normalizeMergePolicy(policy).verifiedAutonomy?.enabled
      ? await loadVerifiedAttestation(this.db, changeId, change.headCommit, change.openedByAgentId ?? null)
      : undefined;
    return evaluateMerge({
      policy,
      risk: change.risk,
      // Fail closed: a Change predating risk computation (null) has unknown
      // true risk — treat as high so it can't slip through on a stale
      // agent-declared `Risk: low`. Every current push sets computedRisk.
      computedRisk: (change.computedRisk as Risk | null) ?? "high",
      scope: change.scope as string[],
      changedPaths: change.changedPaths as string[],
      openedByAgentId: change.openedByAgentId ?? undefined,
      openedByUserId: change.openedByUserId ?? undefined,
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
      verifiedAttestation,
    });
  }

  /**
   * Hands-off auto-merge: if the repo opted into `autoMergeOnVerified`, the
   * change was e2e-verified for its CURRENT head, AND it is now mergeable under
   * policy, enqueue a server-side merge. Idempotent — the `requestId` is keyed on
   * (changeId, headCommit) and the MergeWorker re-evaluates under the repo lock,
   * so a no-longer-mergeable or already-merged change is a safe no-op. Best
   * effort: never throws into the caller (auto-merge is additive to the manual
   * merge path). Returns true when a merge was enqueued.
   *
   * Driven from the EventBus (app.ts) on review.submitted / ci.completed /
   * change.verified so it fires whichever gate (review, CI, verification) lands
   * last. Gating on a present attestation means ONLY verified changes auto-merge.
   */
  async maybeEnqueueAutoMerge(changeId: string): Promise<boolean> {
    if (!this.mergeQueue) return false;
    try {
      const change = await this.get(changeId);
      if (change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned" || change.isDraft || change.hasConflicts) return false;
      const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
      if (!repo) return false;
      const policy = normalizeMergePolicy(repo.mergePolicy);

      // Path 1: human-armed "merge when ready". A human approved a SPECIFIC head and
      // asked to land it the moment the gate goes green (CI passes, approvals in). The
      // arming human is the merge actor and it's evaluated as a HUMAN merge; a new push
      // (head != armedAtCommit) voids the arm — the human approved that exact diff, not
      // whatever lands next. Independent of the repo's verified-autonomy policy.
      const am = (change.autoMerge ?? null) as { enabled?: boolean; byUserId?: string; method?: MergeMethod; armedAtCommit?: string } | null;
      if (am?.enabled && am.byUserId && am.armedAtCommit === change.headCommit) {
        // Re-validate the arming human STILL has repo write. The arm fires later from an
        // event with no auth context, so a collaborator whose access was revoked after
        // arming must not still land a merge as themselves. Lost access → disarm + skip.
        const access = await repoAccessFor(this.db, repo, { kind: "user", userId: am.byUserId } as TokenPayload);
        if (access !== "write" && access !== "admin") { await this.disarmAutoMerge(changeId); return false; }
        const decision = await this.evaluate(changeId);
        if (!decision.mergeable) return false; // armed but the gate isn't green yet — a later trigger re-checks
        await this.mergeQueue.enqueue({
          changeId, repoId: change.repoId,
          by: { kind: "human", id: am.byUserId },
          method: am.method ?? policy.defaultMergeMethod ?? "merge",
          requestId: `armed:${changeId}:${change.headCommit}`,
          expectHead: change.headCommit, // re-asserted under the repo lock at merge time
        });
        log("info", "auto_merge_enqueued", { changeId, repoId: change.repoId, headCommit: change.headCommit, armed: true });
        return true;
      }

      // Path 2: verified-autonomy auto-merge (repo policy opt-in).
      if (!policy.autoMergeOnVerified) return false;
      // Only auto-merge a change that was actually verified e2e for its live head
      // (a stale attestation from a prior push won't match the head and so won't
      // load). A human-approved-but-unverified change is left for a manual merge.
      const att = await loadVerifiedAttestation(this.db, changeId, change.headCommit, change.openedByAgentId ?? null);
      if (!att) return false;
      // Auto-merge is performed by an agent → evaluate with the strict agent-CI
      // rule, so a verified-but-CI-not-green change is never even enqueued.
      const decision = await this.evaluate(changeId);
      if (!decision.mergeable) return false;
      await this.mergeQueue.enqueue({
        changeId,
        repoId: change.repoId,
        by: { kind: "agent", id: att.agentId },
        expectHead: change.headCommit, // re-asserted under the repo lock at merge time
        method: policy.defaultMergeMethod ?? "merge",
        requestId: `auto:${changeId}:${change.headCommit}`,
      });
      log("info", "auto_merge_enqueued", { changeId, repoId: change.repoId, headCommit: change.headCommit, verifiedAutonomyUsed: !!decision.verifiedAutonomyUsed });
      return true;
    } catch (e) {
      log("warn", "auto_merge_enqueue_failed", { changeId, err: (e as Error).message });
      return false;
    }
  }

  /**
   * Arm "merge when ready" on a change: a human approves a diff now and lets it land
   * automatically the moment its merge gate goes green (CI passes, approvals in). The
   * arm is pinned to the current head — a later push voids it (the human approved that
   * exact diff). Tries an immediate enqueue in case the gate is already green.
   */
  async armAutoMerge(changeId: string, byUserId: string, method?: MergeMethod): Promise<boolean> {
    const change = await this.get(changeId);
    if (change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned") throw new ValidationError("change is closed");
    if (change.isDraft) throw new ValidationError("publish the draft before arming auto-merge");
    if (change.hasConflicts) throw new ValidationError("resolve the merge conflicts before arming auto-merge");
    // Validate the method up front against the repo's allowed set — a bad pin would
    // otherwise only surface deep in the merge worker when the gate finally goes green.
    if (method) {
      const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
      const allowed = normalizeMergePolicy(repo?.mergePolicy).allowedMergeMethods ?? ["merge", "squash", "rebase"];
      if (!allowed.includes(method)) throw new ValidationError(`merge method "${method}" is not allowed on this repo`);
    }
    await this.db.update(changes)
      .set({ autoMerge: { enabled: true, byUserId, method: method ?? null, armedAtCommit: change.headCommit }, updatedAt: new Date() })
      .where(eq(changes.id, changeId));
    return this.maybeEnqueueAutoMerge(changeId);
  }

  /** Cancel a pending "merge when ready" arm. */
  async disarmAutoMerge(changeId: string): Promise<void> {
    await this.db.update(changes).set({ autoMerge: null, updatedAt: new Date() }).where(eq(changes.id, changeId));
  }

  async merge(changeId: string, by: { kind: "agent" | "human"; id: string }, method: MergeMethod = "merge", opts: { expectHead?: string } = {}): Promise<{ mergeCommit: string; method: MergeMethod }> {
    const initial = await this.get(changeId);
    const result = await withRepoLock(initial.repoId, () => this.mergeLocked(changeId, by, method, opts), { kind: "merge", ttlMs: 60_000, waitMs: 10_000 });
    // Merged — cancel any in-flight validation run (push CI / agent verify / review)
    // still pinned to this change; verifying a merged diff proves nothing and wastes a
    // runner slot. The merge→deploy run (origin='merge') is excluded by cancelChangeRuns.
    await cancelChangeRuns(this.db, this.events, changeId, "stale").catch(() => {});
    return result;
  }

  private async mergeLocked(changeId: string, by: { kind: "agent" | "human"; id: string }, method: MergeMethod, opts: { expectHead?: string } = {}): Promise<{ mergeCommit: string; method: MergeMethod }> {
    const change = await this.get(changeId);
    // Head pin (deferred/auto-merge): the job was authorized against a specific head.
    // Re-assert it here, UNDER the repo lock, so a push that landed a new diff after
    // the job was enqueued can never merge the un-approved head as the arming user.
    if (opts.expectHead && change.headCommit !== opts.expectHead) {
      throw new ConflictError("head moved since the merge was queued — re-approve the new diff");
    }
    if (change.isDraft) throw new ConflictError("draft changes cannot be merged");
    if (change.status === "merged") throw new ConflictError("already merged");
    if (change.status === "rolled_back") throw new ConflictError("change rolled back");
    if (change.status === "abandoned") throw new ConflictError("change abandoned");
    if (change.hasConflicts) throw new ConflictError("change has merge conflicts");

    let decision = await this.evaluate(changeId);
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
      // Exclude the AUTHOR so the floor measures INDEPENDENT approvals —
      // mirroring evaluateMerge's author exclusion. For an agent author that's
      // the agent + its owning user; for a HUMAN author it's the human (who
      // could otherwise satisfy requiredApprovals by approving their own change).
      const authorIds = new Set<string>();
      if (change.openedByAgentId) {
        authorIds.add(change.openedByAgentId);
        const opener = (await this.db.select().from(agents).where(eq(agents.id, change.openedByAgentId)).limit(1))[0];
        if (opener?.associatedUserId) authorIds.add(opener.associatedUserId);
        if (opener?.serviceUserId) authorIds.add(opener.serviceUserId);
      }
      if (change.openedByUserId) authorIds.add(change.openedByUserId);
      const revs = await this.db.select().from(reviews).where(and(eq(reviews.changeId, changeId), isNull(reviews.supersededAt), eq(reviews.advisory, false)));
      approverCount = new Set(revs.filter(r => r.verdict === "approve" && !authorIds.has(r.reviewerId)).map(r => r.reviewerId)).size;
    }
    const violation = branchProtectionViolation(protection, {
      method, ciStatus: change.ciStatus, changeBranch: change.branch, defaultBranch: repo.defaultBranch, approverCount,
    });
    if (violation) throw new ForbiddenError(violation, "branch_protection");

    // Moment-of-merge re-validation, still under the repo lock. The gate above ran
    // before the branch-protection DB reads; CI (or any gate input) can change in
    // that window — a CI run reporting `failure` between the first evaluate() and
    // the awaited git merge below would otherwise let the change land red, because
    // recomputeChangeCiStatus writes ciStatus outside the merge lock. Re-read fresh
    // and re-run the FULL gate immediately before committing, and reuse this
    // fresher decision for the audit record below.
    decision = await this.evaluate(changeId);
    if (!decision.mergeable) throw new ForbiddenError(`merge blocked: ${decision.reason}`, "merge_blocked");
    // The CI status this merge is AUTHORIZED on — stamped onto the merged row below
    // so the record is honest. recomputeChangeCiStatus writes ciStatus outside this
    // lock and could land a 'failure' in the window between the git merge and the
    // status='merged' write; stamping here (plus that write's non-terminal scoping)
    // means a merged change always records the CI status that actually let it merge.
    const authorizedCiStatus = (await this.get(changeId)).ciStatus;

    const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
    const actor = await this.actorIdentity(by);
    const opener = await this.openerName(change);
    const msgMerge = `Merge change: ${change.intent}\n\n${opener.kind}: ${opener.name}\nChange-Id: ${changeId}\n`;
    const msgSquash = `${change.intent}\n\n${opener.kind}: ${opener.name}\nChange-Id: ${changeId}\n`;

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

    // Keep the default-branch head current. `on: event` / `on: schedule` pipelines (and
    // the scheduler) resolve their commit from branches.headCommit via resolveRepoTarget,
    // but a merge advances only the git ref — it does NOT push, so nothing else updates
    // this table. Without this write, every post-merge triggered run (e.g. change.merged
    // fan-out) checked out the last PUSHED commit, not the merge commit — a stale trunk.
    // 0 rows if the default branch isn't tracked yet (safe no-op).
    await this.db.update(branches)
      .set({ headCommit: mergeCommit, updatedAt: new Date() })
      .where(and(eq(branches.repoId, repo.id), eq(branches.name, repo.defaultBranch)));

    // Auto-register in-repo CI pipelines (.clawhub/ci/*.yml) at the merge commit —
    // the same sync a default-branch PUSH does (post-push.ts). A repo that advances
    // by MERGE (like clawhub itself) would otherwise never pick up a newly-added
    // pipeline without a manual registration (e.g. the build-harness-amd64
    // auto-publish pipeline). Additive (never deletes DB-only pipelines) + non-fatal.
    try {
      await syncRepoPipelines(this.db, this.git, ns, repo.name, repo.id, mergeCommit);
    } catch (e) { log("warn", "merge_pipeline_sync_failed", { repoId: repo.id, err: (e as Error).message }); }

    await this.db.update(changes).set({
      status: "merged",
      mergedAt: new Date(),
      mergedBy: by.id,
      mergeMethod: method,
      mergeCommit,
      // Re-stamp the CI status the merge was authorized on (fences out a late
      // recomputeChangeCiStatus write that landed in the git-merge window).
      ciStatus: authorizedCiStatus,
      updatedAt: new Date(),
    }).where(eq(changes.id, changeId));

    // Auto-close Closes: issues.
    await this.db.update(issues).set({ status: "closed", updatedAt: new Date() })
      .where(and(eq(issues.repoId, change.repoId), eq(issues.closingChangeId, changeId)));

    // Public activity (if public repo). Attribute to the change's author —
    // agent or human.
    if (repo.isPublic) {
      await this.db.insert(publicActivity).values({
        repoId: repo.id,
        agentId: change.openedByAgentId,
        userId: change.openedByUserId,
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
      payload: { method, mergeCommit, actorName: actor.name },
    });

    // Memory capture: the merge is the success label (outcome-conditioned memory —
    // reflect pairs merged vs rolled-back episodes over the same paths).
    await captureChangeMerged(this.db, change, { actorName: actor.name });

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
          openedByUserId: change.openedByUserId,
          codeReviewRequired: decision.codeReviewRequired ?? false,
          independentApproverRequired: decision.independentApproverRequired ?? false,
          satisfiedBasis: decision.satisfiedBasis ?? null,
        },
      });
    } catch { /* audit must never break the merge */ }

    // Notify the change's opener that it merged. Best-effort: notification
    // delivery must never fail a completed merge.
    try {
      await notifyChangeMerged(this.db, {
        changeId, repoId: repo.id, repoFullName: `${ns}/${repo.name}`,
        link: `/repos/${ns}/${repo.name}/changes/${changeId}`,
        intent: change.intent, openedByUserId: change.openedByUserId, onBehalfOfUserId: change.onBehalfOfUserId,
        by,
      });
    } catch (err) {
      log("warn", "change_merged_notify_failed", { changeId, err: (err as Error).message });
    }

    // Merge-triggered pipelines (`on: merge` in the yaml) — the deploy hook.
    // Queued at the merge commit so the runner builds exactly what landed.
    const mergePipelines = (await this.db.select().from(ciPipelines)
      .where(and(eq(ciPipelines.repoId, repo.id), eq(ciPipelines.enabled, true))))
      .filter(p => pipelineTrigger(p.yaml) === "merge");
    for (const p of mergePipelines) {
      const runnerToken = randomToken(18);
      // Serialize merge→deploy runs per repo: every merge fires a deploy that
      // runs in the ONE shared production checkout, so two overlapping deploys
      // race (and a self-deploy's `git fetch` died on it). A per-repo concurrency
      // group makes them run one-at-a-time, newest-first — no more lost deploys.
      const run = (await this.db.insert(ciRuns).values({ repoId: repo.id, changeId, pipelineId: p.id, runnerToken, origin: "merge", triggerDepth: 0, commit: mergeCommit, concurrencyGroup: `merge:${repo.id}`, ...ciSchedulingStamp("merge") }).returning())[0];
      // Capability-graded execution (deploy pipelines are the legit host case): host only
      // for an operator-allowlisted repo that requested `execution: host`; else contained.
      // Resolved server-side; runner obeys the stamped value, not the YAML. See ci-host-exec.ts.
      // Also carry runs_on so a deploy pipeline can pin itself to the ONE box that owns the
      // production checkout: without it BOTH runners (incl. the amd64 offload box) are eligible
      // to claim the deploy, and a wrong-box claim runs self-deploy.sh where no prod stack lives
      // => a stranded/failed deploy. The runner skips a run whose runsOn != its arch.
      const trigger = parsePipelineTrigger(p.yaml);
      const execution = resolveCiExecution(trigger.config.execution, ns, repo.name, repo.id);
      await this.events.publish({
        type: "ci.run.queued", repoId: repo.id, changeId, actorKind: by.kind, actorId: by.id,
        payload: {
          runId: run.id, repoNs: ns, repoName: repo.name, commit: mergeCommit,
          pipelineYaml: p.yaml, runnerToken, execution,
          ...(trigger.config.runsOn ? { runsOn: trigger.config.runsOn } : {}),
        },
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

  /** Is the Change behind its base (default) branch — base has commits the change lacks? */
  async isBehindBase(change: { repoId: string; headCommit: string }): Promise<boolean> {
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) return false;
    try {
      const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
      const shard = await this.shardFor(repo.id);
      if (shard && !isLocal(shard)) {
        if (!this.gitClients) return false;
        const client = this.gitClients.rpc(shard);
        const baseSha = await client.resolveRef(ns, repo.name, repo.defaultBranch);
        if (!baseSha || baseSha === change.headCommit) return false;
        return !(await client.isAncestor(ns, repo.name, baseSha, change.headCommit));
      }
      const baseSha = await this.git.headCommit(ns, repo.name, repo.defaultBranch);
      if (baseSha === change.headCommit) return false;
      return !(await this.git.isAncestor(ns, repo.name, baseSha, change.headCommit));
    } catch { return false; }
  }

  /**
   * "Update branch" — bring a Change current with its base (default) branch WITHOUT
   * merging the Change: either merge the base INTO the change (a merge commit) or
   * rebase the change ONTO the base. Moves the Change head + ref + branches row,
   * clears hasConflicts, and RE-RUNS the on:push CI against the new head (otherwise
   * the Change would sit at a stale CI status). Content conflicts can't be
   * auto-resolved — they surface as a ConflictError telling the caller to rebase
   * locally. The Change stays pending; only merge() closes it.
   */
  async updateBranch(changeId: string, by: { kind: "agent" | "human"; id: string }, method: "merge" | "rebase" = "merge"): Promise<{ updated: boolean; reason?: string; headCommit?: string; method?: "merge" | "rebase" }> {
    const change = await this.get(changeId);
    if (change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned") throw new ConflictError("change is closed");
    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");
    const shard = await this.shardFor(repo.id);
    const sharded = !!(shard && !isLocal(shard));
    if (sharded && !this.gitClients) throw new ValidationError("shard client unavailable for update-branch");
    const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);

    return withRepoLock(change.repoId, async () => {
      const actor = await this.actorIdentity(by);
      const msg = `Merge ${repo.defaultBranch} into ${change.branch}\n\nUpdate-Branch: ${repo.defaultBranch}\nChange-Id: ${changeId}\n`;
      let newHead: string;

      if (sharded) {
        // The shard computes the new head (behind + conflict checks included)
        // WITHOUT moving base; we point the Change ref at it.
        const client = this.gitClients!.rpc(shard!);
        let res: { head: string; alreadyCurrent: boolean };
        try {
          res = await client.updateBranchInto({ namespace: ns, name: repo.name, baseBranch: repo.defaultBranch, headCommit: change.headCommit, authorName: actor.name, authorEmail: actor.email, message: msg, method });
        } catch (e) {
          if ((e as { status?: number }).status === 409) throw new ConflictError(`change conflicts with ${repo.defaultBranch} — resolve locally: git fetch && git rebase origin/${repo.defaultBranch} && push`);
          throw e;
        }
        if (res.alreadyCurrent) return { updated: false, reason: "up_to_date" };
        newHead = res.head;
        await client.updateRef(ns, repo.name, `refs/changes/${changeId}`, "", newHead);
        try { await client.updateRef(ns, repo.name, `refs/clawhub/changes/${changeId}`, "", newHead); } catch { /* legacy ref optional */ }
      } else {
        const baseSha = await this.git.headCommit(ns, repo.name, repo.defaultBranch);
        // Already current? (base is an ancestor of the change head.)
        if (baseSha === change.headCommit || await this.git.isAncestor(ns, repo.name, baseSha, change.headCommit)) {
          return { updated: false, reason: "up_to_date" };
        }
        // Content conflict → can't auto-resolve; the caller must rebase locally.
        const trial = await this.git.trialMerge(ns, repo.name, baseSha, change.headCommit);
        if (trial.conflicts) throw new ConflictError(`change conflicts with ${repo.defaultBranch} — resolve locally: git fetch && git rebase origin/${repo.defaultBranch} && push`);
        try {
          newHead = await this.git.updateBranchInto(ns, repo.name, change.headCommit, baseSha, method, actor.name, actor.email, msg);
        } catch {
          throw new ConflictError(`could not auto-update — resolve conflicts locally (git rebase origin/${repo.defaultBranch})`);
        } finally {
          void this.git.gcAuto(ns, repo.name);
        }
        // Point the Change ref(s) at the new head so clones + CI fetch it.
        await this.git.updateRef(ns, repo.name, `refs/changes/${changeId}`, newHead);
        try { await this.git.updateRef(ns, repo.name, `refs/clawhub/changes/${changeId}`, newHead); } catch { /* legacy ref optional */ }
      }
      await this.db.update(changes).set({ headCommit: newHead, hasConflicts: false, ciStatus: "pending", updatedAt: new Date() }).where(eq(changes.id, changeId));
      await this.db.update(branches).set({ headCommit: newHead, updatedAt: new Date() }).where(and(eq(branches.repoId, change.repoId), eq(branches.name, change.branch)));

      // Re-run the on:push pipelines against the new head (mirrors post-push) so CI
      // reflects the updated code instead of the pre-update result.
      const pipelines = (await this.db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repo.id), eq(ciPipelines.enabled, true)))).filter(p => p.triggerKind === "push");
      for (const p of pipelines) {
        const runnerToken = randomToken(18);
        const trigger = parsePipelineTrigger(p.yaml);
        const execution = resolveCiExecution(trigger.config.execution, ns, repo.name, repo.id);
        const run = (await this.db.insert(ciRuns).values({ repoId: repo.id, changeId, pipelineId: p.id, runnerToken, origin: "push", triggerDepth: 0, commit: newHead, ...ciSchedulingStamp("push", { runsOn: trigger.config.runsOn ?? null }) }).returning())[0];
        await this.events.publish({ type: "ci.run.queued", repoId: repo.id, changeId, actorKind: by.kind, actorId: by.id, payload: { runId: run.id, repoNs: ns, repoName: repo.name, commit: newHead, changeId, pipelineYaml: p.yaml, runnerToken, execution, ...(trigger.config.runsOn ? { runsOn: trigger.config.runsOn } : {}) } });
      }
      if (pipelines.length === 0) {
        await this.db.update(changes).set({ ciStatus: "skipped" }).where(eq(changes.id, changeId));
      }

      await this.events.publish({ type: "change.updated", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id, payload: { updatedBranch: true, method, headCommit: newHead, baseBranch: repo.defaultBranch } });
      return { updated: true, headCommit: newHead, method };
    }, { kind: "update-branch", ttlMs: 60_000, waitMs: 10_000 });
  }

  async rollback(changeId: string, by: { kind: "agent" | "human"; id: string }, opts: { reason?: string | null } = {}): Promise<void> {
    const change = await this.get(changeId);
    if (change.status !== "merged") throw new ValidationError("only merged changes can be rolled back");

    const repo = (await this.db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("repo");

    if (change.mergeCommit) {
      // `GitService.open()` only ever operates on the LOCAL on-disk bare repo path —
      // it has no sharded-repo path (unlike updateBranch's git-client.ts route). Rather
      // than silently reverting against a path that may not reflect a git-service
      // shard's real repo state, refuse up front with a clear error.
      const shard = await this.shardFor(repo.id);
      if (shard && !isLocal(shard)) {
        throw new GitError("rollback is not yet supported for repos placed on a git-service shard — revert manually via git and update the change status");
      }

      const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
      const actor = await this.actorIdentity(by);
      const msg = `Revert merge of change: ${change.intent}\n\nReverts: ${change.mergeCommit}\nChange-Id: ${changeId}\n`;

      // Same lock kind ("merge") that merge() takes — a rollback and a concurrent
      // merge()/rollback() on this repo must serialize, not interleave, since both
      // mutate the default-branch ref + branches.headCommit. The baseSha read is
      // deliberately taken INSIDE the lock so it's fresh relative to any writer
      // that just released it, rather than racing a stale read against a write.
      await withRepoLock(repo.id, async () => {
        let revertCommit: string;
        try {
          // Create a revert commit on top of the default branch using the tree from the pre-merge parent.
          const g = this.git.open(ns, repo.name).env({
            GIT_AUTHOR_NAME: actor.name, GIT_AUTHOR_EMAIL: actor.email,
            GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email,
          });
          const baseSha = (await g.revparse([repo.defaultBranch])).trim();
          const prevSha = (await g.revparse([`${change.mergeCommit}^1`])).trim();
          const prevTree = (await g.revparse([`${prevSha}^{tree}`])).trim();
          revertCommit = (await g.raw(["commit-tree", prevTree, "-p", baseSha, "-m", msg])).trim();
          await g.raw(["update-ref", `refs/heads/${repo.defaultBranch}`, revertCommit, baseSha]);
        } catch (e) {
          // Do NOT mark the change rolled back — the bad code is still live on the
          // default branch. Surface the failure so an operator relying on rollback
          // as an incident-response mechanism finds out immediately, not later.
          throw new GitError(`rollback failed: could not create revert commit (${(e as Error).message ?? e})`);
        }

        // Keep `branches.headCommit` current, mirroring merge() — otherwise
        // `on: event`/`on: schedule` triggers + the dashboard branch view keep
        // resolving the reverted (bad) commit as the branch head.
        await this.db.update(branches)
          .set({ headCommit: revertCommit, updatedAt: new Date() })
          .where(and(eq(branches.repoId, repo.id), eq(branches.name, repo.defaultBranch)));
      }, { kind: "merge", ttlMs: 60_000, waitMs: 10_000 });
    }

    await this.db.update(changes).set({ status: "rolled_back", updatedAt: new Date() }).where(eq(changes.id, changeId));

    // Public activity (if public repo) — mirrors the change.merged block in
    // merge() above, attributed to the change's ORIGINAL author (not the
    // rollback actor), so /trending, RSS, the changelog, and the author's
    // identity activity history see the platform's most notable negative event.
    if (repo.isPublic) {
      await this.db.insert(publicActivity).values({
        repoId: repo.id,
        agentId: change.openedByAgentId,
        userId: change.openedByUserId,
        kind: "change.rolled_back",
        changeId,
        summary: change.intent,
      });
    }

    // Reopen any issue this change auto-closed via Closes: — mirrors merge()'s
    // close exactly (same where clause, status flipped the other way) so the
    // open queue reflects that the closing work no longer exists on the default
    // branch. closingChangeId is left in place: it's still useful provenance
    // ("closed by this change, which was later rolled back"). Only touches
    // issues that are currently closed — an issue already reopened by a human
    // before the rollback is left alone, not double-processed.
    await this.db.update(issues).set({ status: "open", updatedAt: new Date() })
      .where(and(eq(issues.repoId, change.repoId), eq(issues.closingChangeId, changeId), eq(issues.status, "closed")));

    const rbActor = await this.actorIdentity(by).catch(() => null);
    await this.events.publish({ type: "change.rolled_back", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id, payload: { actorName: rbActor?.name, reason: opts.reason ?? null } });

    // Notify the change's opener that their merged work was just rolled back.
    // Best-effort: notification delivery must never fail a completed rollback.
    try {
      const ns = await this.namespaceName(repo.namespaceType, repo.namespaceId);
      await notifyChangeRolledBack(this.db, {
        changeId, repoId: repo.id, repoFullName: `${ns}/${repo.name}`,
        link: `/repos/${ns}/${repo.name}/changes/${changeId}`,
        intent: change.intent, reason: opts.reason ?? null,
        openedByUserId: change.openedByUserId, onBehalfOfUserId: change.onBehalfOfUserId,
        by,
      });
    } catch (err) {
      log("warn", "change_rolled_back_notify_failed", { changeId, err: (err as Error).message });
    }

    // Memory capture: a rollback is the strongest negative outcome the platform
    // sees — a kind:failure with the reason + the change's paths, fingerprinted
    // so repeated rollback causes cluster for consolidation. The free-text
    // reason is embedded ONLY from a HUMAN actor: an agent-supplied reason would
    // be an unreviewed high-importance write into every collaborator's pack
    // (exactly what the shared-scope pending gate exists to prevent).
    await captureRollback(this.db, change, {
      reason: by.kind === "human" ? opts.reason : null,
      actorName: rbActor?.name,
    });

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
          openedByUserId: change.openedByUserId,
        },
      });
    } catch { /* audit must never break the rollback */ }
  }

  /**
   * Abandon an UNMERGED Change — a garbage / dead-end diff the author or a
   * maintainer wants to close WITHOUT merging (distinct from rollback, which
   * reverts a MERGED change; and from delete-branch retraction, which the push
   * path does). Terminal: it drops out of the review queue (attention filters to
   * pending/approved/changes_requested), cannot merge or auto-merge, and no
   * reviewer runs on it. Reopenable via reopen(). Idempotent; refuses a merged
   * change (use rollback for that).
   */
  async abandon(changeId: string, by: { kind: "agent" | "human"; id: string }, opts: { reason?: string | null } = {}): Promise<void> {
    const change = await this.get(changeId);
    if (change.status === "merged") throw new ConflictError("cannot abandon a merged change (use rollback)");
    if (change.status === "rolled_back") throw new ConflictError("change already rolled back");
    if (change.status === "abandoned") return; // idempotent
    await this.db.update(changes).set({ status: "abandoned", updatedAt: new Date() }).where(eq(changes.id, changeId));
    // Abandoned — cancel any in-flight CI / verify / review run for this change.
    await cancelChangeRuns(this.db, this.events, changeId, "canceled").catch(() => {});
    const actor = await this.actorIdentity(by).catch(() => null);
    await this.events.publish({ type: "change.abandoned", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id, payload: { actorName: actor?.name, reason: opts.reason ?? null } });
    try {
      await getAuditLog(this.db).record({
        repoId: change.repoId, actorKind: by.kind, actorId: by.id,
        action: "change.abandoned", category: "change",
        metadata: { changeId, openedByAgentId: change.openedByAgentId, openedByUserId: change.openedByUserId, reason: opts.reason ?? null },
      });
    } catch { /* audit must never break the abandon */ }
  }

  /**
   * Let a human edit a Change's description (the `intent`). At push time
   * `intent` is populated ONLY from the commit `Intent:` trailer and is frozen
   * thereafter — this is the sole edit path. Editing description METADATA is not
   * a git commit, so the "only agents commit" invariant is preserved (a user
   * writer may call this). Validation: the trimmed intent must be non-empty and
   * at most `MAX_INTENT_LEN`. Returns the updated change row (same shape the GET
   * change detail returns).
   */
  async updateIntent(changeId: string, intent: string, by: { kind: "agent" | "human"; id: string }): Promise<typeof changes.$inferSelect> {
    const trimmed = validateIntent(intent);
    const change = await this.get(changeId);
    // A closed Change's description is immutable, mirroring markDraft/rollback —
    // editing it would also bump updatedAt and float a long-merged change back to
    // the top of the (desc updatedAt) change list.
    if (change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned") {
      throw new ConflictError("cannot edit the description of a closed change");
    }
    const updated = (await this.db.update(changes)
      .set({ intent: trimmed, updatedAt: new Date() })
      .where(eq(changes.id, changeId)).returning())[0];
    await this.events.publish({ type: "change.updated", repoId: change.repoId, changeId, actorKind: by.kind, actorId: by.id, payload: { intentEdited: true } });
    return updated;
  }

  async markDraft(changeId: string, draft: boolean): Promise<void> {
    const change = await this.get(changeId);
    if (change.status === "merged" || change.status === "rolled_back" || change.status === "abandoned") throw new ConflictError("cannot change draft state of closed change");
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
    // Reopen returns a change to `pending`: from `changes_requested` (undo a
    // mis-clicked request-changes) OR from `abandoned` (un-abandon a diff). Never
    // resurrects a merged/rolled_back change.
    if (change.status !== "changes_requested" && change.status !== "abandoned") {
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
    const prev = ((change.requestedReviewers as Array<{ kind: string; id: string }> | null) ?? []);
    const prevHumanIds = new Set(prev.filter(r => r.kind === "human").map(r => r.id));
    const prevAgentIds = new Set(prev.filter(r => r.kind === "agent").map(r => r.id));
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
    // Requesting an AGENT reviewer should actually RUN it — otherwise "request a
    // reviewer" is a no-op for agents (the old behavior: it set the list and
    // pinged humans, but nothing dispatched the agent). For each NEWLY-added
    // agent reviewer that is an enabled standing agent in this repo, fire a
    // one-off run (manual) so the reviewer container boots and posts its verdict.
    // Best-effort: a dispatch failure must never fail the request itself.
    const newAgentIds = [...new Set(reviewers.filter(r => r.kind === "agent").map(r => r.id))]
      .filter(id => !prevAgentIds.has(id));
    if (newAgentIds.length) {
      try {
        const { dispatchStandingRun } = await import("./standing-agents.js");
        const sas = await this.db.select().from(standingAgents).where(and(
          eq(standingAgents.repoId, change.repoId),
          inArray(standingAgents.agentId, newAgentIds),
          eq(standingAgents.enabled, true),
        ));
        for (const sa of sas) {
          await dispatchStandingRun(this.db, this.events, sa, { manual: true })
            .catch(err => log("warn", "request_reviewer_dispatch_failed", { changeId, agentId: sa.agentId, err: (err as Error).message }));
        }
      } catch (err) {
        log("warn", "request_reviewer_dispatch_failed", { changeId, err: (err as Error).message });
      }
    }
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

  /** Display name of whoever opened the change — agent name or human handle —
   *  for the merge-commit trailer. */
  private async openerName(change: { openedByAgentId: string | null; openedByUserId: string | null }): Promise<{ name: string; kind: "Agent" | "Author" }> {
    if (change.openedByUserId) {
      const u = (await this.db.select().from(users).where(eq(users.id, change.openedByUserId)).limit(1))[0];
      return { name: u?.username ?? u?.name ?? u?.email ?? "unknown", kind: "Author" };
    }
    const a = change.openedByAgentId
      ? (await this.db.select().from(agents).where(eq(agents.id, change.openedByAgentId)).limit(1))[0]
      : undefined;
    return { name: a?.name ?? "unknown", kind: "Agent" };
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
