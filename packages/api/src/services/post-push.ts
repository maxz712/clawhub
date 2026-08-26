import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, ciPipelines, ciRuns, issues, issueChanges, publicActivity, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { cancelSupersededHeadRuns } from "./run-staleness.js";
import { ciSchedulingStamp } from "./job-scheduling.js";
import { parseTrailers, describeCommits } from "./trailer-parser.js";
import { resolveDiffBase, deriveComputedRisk, deriveReviewBrief, deriveVerifyTier, type DiffStats } from "./change-derivation.js";
import { extractInlineReviewComments, mergeFocus } from "./focus-parser.js";
import { randomToken } from "./auth.js";
import { enforceRate, enforceScope } from "./agent-scope.js";
import { ForbiddenError } from "./errors.js";
import { scanChange as sastScan } from "./sast.js";
import { scanRepoHead } from "./dep-scan.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";
import { isAgentKilled } from "./kill-switch.js";
import { getAuditLog } from "./audit.js";
import { readRepoPolicy } from "./policy-dsl.js";
import { syncRepoPipelines } from "./ci.js";
import { parsePipelineTrigger } from "./ci-yaml.js";
import { resolveCiExecution } from "./ci-host-exec.js";
import { captureChangeOpened } from "./memory-capture.js";
import { indexRepoAtCommit } from "./code-index.js";
import { buildCodeGraphAtCommit, graphifyEnabledForRepo } from "./code-graph.js";
import { isScannablePath, scanPushedFiles } from "./secret-scan.js";
import { withChangeUpsertLock } from "./repo-lock.js";
import { normalizeMergePolicy } from "./merge-policy.js";
import { dismissStaleApprovals } from "./stale-approvals.js";
import type { PushActor } from "./push-queue.js";

export interface PushedRef {
  ref: string;          // e.g. refs/heads/feature/x
  oldSha: string;       // 40 zeros for create
  newSha: string;       // 40 zeros for delete
  // True ONLY for the synthetic refs/heads/magic/... entries the runner
  // fabricates after admitMagicRefs. The secret-gate retraction dispatches on
  // THIS fact, never on the branch NAME: nothing reserves "magic/", so a real
  // branch pushed as refs/heads/magic/x would otherwise enter the retraction
  // arm — where its on-disk ref is never reverted (fail-open on first push),
  // its legitimate Change row is deleted on later pushes, and the mid-loop
  // throw re-discovers the ref forever and wedges the repo's push processing.
  viaMagicRef?: boolean;
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
  actor: PushActor;
  pushedRefs: PushedRef[];
}): Promise<void> {
  const { db, git, changeRefs, events, namespace, repoName, repoId, defaultBranch, actor, pushedRefs } = params;
  // The pushing identity is an agent OR a human user. Agent-only machinery (kill
  // switch, rate/scope quotas, stats, cost) is gated on this; the Change is
  // authored by whichever one pushed. `actorKind` feeds events + audit.
  const agentId = actor.kind === "agent" ? actor.agentId : null;
  const userId = actor.kind === "user" ? actor.userId : null;
  const actorKind: "agent" | "human" = actor.kind === "agent" ? "agent" : "human";
  const actorId = actor.kind === "agent" ? actor.agentId : actor.userId;
  // Display name for the actor so live-feed events read "@alice" / "botzilla"
  // instead of a generic "A human" / short id. Resolved once per push.
  let actorName: string | undefined;
  if (agentId) {
    actorName = (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1))[0]?.name;
  } else if (userId) {
    const u = (await db.select({ username: users.username, name: users.name, email: users.email }).from(users).where(eq(users.id, userId)).limit(1))[0];
    actorName = u?.username ?? u?.name ?? u?.email;
  }

  for (const r of pushedRefs) {
    if (!r.ref.startsWith("refs/heads/")) continue;
    const branch = r.ref.slice("refs/heads/".length);
    const deleted = /^0+$/.test(r.newSha);

    if (deleted) {
      const existing = (await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, branch))).limit(1))[0];
      if (existing?.protection) {
        const prot = existing.protection as { blockDeletion?: boolean };
        if (prot.blockDeletion) {
          // #189: post-push runs AFTER git applied the deletion, so "block" must
          // RESTORE the ref, not just throw — and it must restore BEFORE the
          // throw skips the `branches` delete below: a surviving row pointing at
          // a gone ref is re-inferred as "deleted by this push" by the runner's
          // priorHeads diff on every later push, wedging the whole repo (the
          // same poison the secret gate's revert comment documents). CAS form
          // (create-only, old value = zeros) so a concurrent legitimate
          // recreation isn't clobbered. `r.oldSha` is the prior head.
          try { await git.open(namespace, repoName).raw(["update-ref", r.ref, r.oldSha, "0".repeat(40)]); }
          catch (e) { log("warn", "branch_protection_restore_failed", { repoId, branch, err: (e as Error).message }); }
          metrics.inc("clawhub_branch_protection_rejected_total", { control: "deletion" });
          // Post-receive rejection is invisible to the pusher by construction —
          // it must not also be invisible to the owner.
          await getAuditLog(db).record({
            repoId, actorKind, actorId, category: "repo",
            action: "branch_protection.deletion_blocked", metadata: { branch, restoredTo: r.oldSha },
          });
          throw new ForbiddenError("branch protection forbids deletion", "branch_protection");
        }
      }
      await db.delete(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, branch)));
      // Deleting a branch retracts its unmerged Change — otherwise it sits in
      // the review queue forever pointing at refs that no longer exist.
      await db.delete(changes).where(and(
        eq(changes.repoId, repoId), eq(changes.branch, branch),
        inArray(changes.status, ["pending", "approved", "changes_requested"]),
      ));
      continue;
    }

    // Branch protection force-push block: only allow FF pushes on protected branches.
    const existingBranch = (await db.select().from(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, branch))).limit(1))[0];
    if (existingBranch?.protection) {
      const prot = existingBranch.protection as { blockForcePush?: boolean };
      if (prot.blockForcePush && !/^0+$/.test(r.oldSha)) {
        // #189: git.isAncestor, NEVER `raw(["merge-base", "--is-ancestor", ...])`
        // — that command signals only through its exit code, and simple-git's
        // raw resolves on exit-1 (no stderr), so the old catch-based probe read
        // every push as fast-forward and the control fired never (the third
        // recorded instance of this trap; see git.ts:isAncestor + #147).
        if (!(await git.isAncestor(namespace, repoName, r.oldSha, r.newSha))) {
          // The ref is already on disk (post-push runs after the receive) — put
          // it back with the same compare-and-swap the requirePullRequest and
          // secret gates use, or "blocked" means nothing the pusher can see.
          try { await git.open(namespace, repoName).raw(["update-ref", r.ref, r.oldSha, r.newSha]); }
          catch (e) { log("warn", "branch_protection_revert_failed", { repoId, branch, err: (e as Error).message }); }
          metrics.inc("clawhub_branch_protection_rejected_total", { control: "force_push" });
          await getAuditLog(db).record({
            repoId, actorKind, actorId, category: "repo",
            action: "branch_protection.force_push_blocked", metadata: { branch, revertedTo: r.oldSha, rejectedSha: r.newSha },
          });
          throw new ForbiddenError("branch protection forbids force-push", "branch_protection");
        }
      }
    }

    // Kill-switch + rate/scope quotas govern AGENTS only. A human pushing their
    // own code is not a suspendable, rate-capped automation — they're the
    // operator. (Their merges are still gated by the merge policy below.)
    if (agentId) {
      // Kill-switch: reject push from a suspended agent.
      if (await isAgentKilled(db, agentId)) {
        throw new ForbiddenError("agent_kill_switch_engaged", "kill_switch");
      }
      // Rate-limit + per-agent scope enforcement.
      await enforceRate(db, agentId, "push");
    }

    // Default-branch push (including the push that creates it): no Change row,
    // but still serialize the branch update through the advisory lock so
    // concurrent pushes to main do not lose the post-push event ordering.
    if (branch === defaultBranch) {
      // requirePullRequest: a direct commit to the protected default branch must
      // go through a Change (refs/for/<branch>) instead. post-push runs AFTER git
      // applied the ref (the kill switch is the only pre-proxy gate), so we REVERT
      // the ref to its prior head — giving the control real teeth rather than the
      // dead merge-path check (a default-branch push never creates a mergeable
      // Change). The branch-CREATING push (oldSha all-zeros) is allowed so a fresh
      // repo can be seeded; only subsequent direct commits are rejected.
      const prot = existingBranch?.protection as { requirePullRequest?: boolean } | undefined;
      const isCreate = /^0+$/.test(r.oldSha);
      // Per-repo opt-in: block AGENT direct pushes to the default branch so a
      // granted agent must route through a Change (preserving the merge gate).
      // Human direct pushes stay allowed by design (operations.md bootstrap).
      // Default off → no behavior change unless a repo enables it.
      let blockAgentDirect = false;
      if (actor.kind === "agent" && !isCreate) {
        const repoRow = (await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
        blockAgentDirect = !!(repoRow?.mergePolicy as { blockAgentDirectDefaultPush?: boolean } | undefined)?.blockAgentDirectDefaultPush;
      }
      if ((prot?.requirePullRequest || blockAgentDirect) && !isCreate) {
        // Compare-and-swap back to oldSha (only if still at newSha) so a concurrent
        // legitimate update isn't clobbered.
        try { await git.open(namespace, repoName).raw(["update-ref", r.ref, r.oldSha, r.newSha]); }
        catch (e) { log("warn", "branch_protection_revert_failed", { repoId, branch, err: (e as Error).message }); }
        throw new ForbiddenError(`branch protection requires a pull request — push to refs/for/${branch} instead of committing directly to ${branch}`, "branch_protection");
      }
      await withChangeUpsertLock(db, repoId, branch, async tx => {
        await tx.insert(branches).values({ repoId, name: branch, headCommit: r.newSha })
          .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });
      });
      await events.publish({ type: "push.default", repoId, actorKind, actorId, payload: { branch, sha: r.newSha, actorName } });

      // Policy-as-code: adopt .clawhub/policies/merge.yml ONLY from the default
      // branch — i.e. after a policy change has itself been reviewed and merged.
      // Reading it from a feature-branch head would let an agent push a
      // permissive policy and have that same push's Change evaluated under it
      // (self-approve, gate disabled). Because the default policy forces human
      // code review on `.clawhub/policies/**`, a policy change can only land
      // through a human — and only then does it take effect. (Fourth victim of
      // the loop-tail reachability trap, #186: this used to sit below this
      // handler's `continue` behind a `branch === defaultBranch` gate that
      // could never be true there.)
      // HUMAN pushes only: the justification above ("a policy change can only
      // land through a human") holds on the MERGE path — `.clawhub/policies/**`
      // is baseline-sensitive, so a Change touching it needs human code review —
      // but a DIRECT default-branch push bypasses the merge gate entirely, and
      // any writer-granted agent can make one under the default posture
      // (blockAgentDirectDefaultPush is opt-in). Without this gate a push grant
      // was admin-equivalent policy mutation: the agent ships a permissive
      // `.clawhub/policies/merge.yml` (minApprovalsHuman: 0, allowSelfReview:
      // true, requireHumanApproval: "never") and every later merge is governed
      // by it. An agent push still lands the FILE; it just never mutates the
      // stored policy — a human adopts it by pushing/merging it themselves.
      try {
        const inRepoPolicy = await readRepoPolicy(git, namespace, repoName, r.newSha);
        if (inRepoPolicy && actorKind !== "human") {
          log("warn", "policy_adoption_skipped_agent_push", { repoId, branch, commit: r.newSha });
        } else if (inRepoPolicy) {
          // #129: the file is a PARTIAL OVERLAY, never a replacement. It used to
          // be coerced to a full MergePolicy (every unnamed key defaulted) and
          // written wholesale — so an adoption silently deleted every key the
          // DSL cannot express (requireCiRun, blockAgentDirectDefaultPush,
          // verifyTier, verifiedAutonomy, autoMergeOnVerified, ...), four of
          // them permissive-ward, and broke the Loop's appliedPolicySha
          // uninstall guard. Only keys the YAML actually names may override;
          // everything else in the DB blob (including keys undeclared on the
          // interface, e.g. verifyTier) survives. Stored raw — consumers
          // normalize on read.
          const current = ((await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories)
            .where(eq(repositories.id, repoId)).limit(1))[0]?.mergePolicy ?? {}) as Record<string, unknown>;
          const merged = { ...current, ...inRepoPolicy };
          if (JSON.stringify(merged) !== JSON.stringify(current)) {
            await db.update(repositories).set({ mergePolicy: merged, updatedAt: new Date() }).where(eq(repositories.id, repoId));
            // An in-repo adoption that changed the effective policy must be
            // visible — a weakening was previously completely silent.
            await getAuditLog(db).record({
              repoId, actorKind, actorId, category: "policy",
              action: "repo.policy.updated", metadata: { source: "in_repo", commit: r.newSha, keys: Object.keys(inRepoPolicy) },
            });
          }
        }
      } catch (e) { log("warn", "policy_load_failed", { repoId, err: (e as Error).message }); }

      // CI as config-as-code: adopt repo-defined pipelines from .clawhub/ci/*.yml
      // (or .clawhub/ci.yml) at this merged default-branch commit. Same trust
      // model as policy-as-code — read only from the default branch, so a CI
      // change only takes effect after it has been reviewed and merged. Additive:
      // DB-only pipelines not present in-repo are left untouched.
      try {
        await syncRepoPipelines(db, git, namespace, repoName, repoId, r.newSha);
      } catch (e) { log("warn", "ci_repo_sync_failed", { repoId, err: (e as Error).message }); }
      // v3 P6 — Graphify must update on DIRECT default-branch pushes: this path
      // `continue`s before the bottom-of-loop maintenance block, whose own
      // default-branch gate is unreachable from here. Detached, best-effort —
      // same posture as the maintenance block below.
      void (async () => {
        try {
          if (await graphifyEnabledForRepo(db, repoId)) {
            await buildCodeGraphAtCommit(db, git, namespace, repoName, repoId, r.newSha, { sinceCommit: r.oldSha });
          }
        } catch (e) { log("warn", "code_graph_failed", { repoId, err: (e as Error).message }); }
        // #118: the dependency/CVE scan must also see DIRECT default-branch
        // pushes — same reachability gap as Graphify above (the bottom-of-loop
        // default-branch gate is unreachable from this path).
        try {
          const { findings } = await scanRepoHead(db, git, {
            namespace, repo: repoName, repoId, commit: r.newSha,
            openIssueCreator: { kind: actorKind, id: actorId },
          });
          if (findings > 0) metrics.inc("clawhub_vuln_findings_total", { repo: repoName }, findings);
        } catch (e) { log("warn", "dep_scan_failed", { repoId, err: (e as Error).message }); }
        // #186: the trigram code index — third victim of the same reachability
        // trap (its only automatic call site sat in the loop tail's dead
        // default-branch gate, so /code/search returned an authoritative empty
        // result on every repo never manually reindexed). Prior tip makes the
        // reindex incremental: only files in the push.
        try {
          await indexRepoAtCommit(db, git, namespace, repoName, repoId, r.newSha, { sinceCommit: r.oldSha });
        } catch (e) { log("warn", "code_index_failed", { repoId, err: (e as Error).message }); }
      })();
      continue;
    }

    // Aggregate trailers across ALL the branch's commits — the same cumulative
    // range the diff, the risk engine and the verify tier are derived from
    // (#175). Deriving metadata from only `oldSha..newSha` made a Change's
    // Intent/Risk/Review-Focus a function of its PUSH HISTORY: a bare
    // "fix typo" follow-up push saw zero trailers and the wholesale row
    // overwrite below erased everything the author declared, while the diff the
    // reviewer sees still spanned the whole branch. Cumulative = a pure
    // function of (base, head), automatically correct under force-push/rebase
    // (a trailer removed by a rebase is genuinely gone). The 200-commit cap +
    // describeCommits' 8KB cap bound the cost.
    const range = `${defaultBranch}..${r.newSha}`;
    let commits: Array<{ sha: string; subject: string; message: string }> = [];
    try { commits = await git.listCommits(namespace, repoName, range, 200); } catch { commits = []; }

    const allTrailers = commits.map(c => parseTrailers(c.message));
    const head = allTrailers[0];
    // Last-declaration-wins for the two single-valued trailers: the NEWEST
    // commit that actually DECLARES Intent:/Risk: (commits are newest-first).
    // A trailer-less fixup inherits; an intentional re-title/re-classification
    // still overrides. `t.intent` alone won't do — parseTrailers falls back to
    // the commit subject, which is exactly the fixup noise to skip.
    const intent = allTrailers.find(t => t.raw["Intent"]?.length)?.intent ?? commits[0]?.subject ?? branch;
    const risk = allTrailers.find(t => t.risk)?.risk ?? "low";
    // `Draft: true/false` on the head commit controls the Change's draft state so a
    // push can keep WIP unreviewed or publish it. undefined (no trailer) preserves
    // the existing state — the API/CLI (markDraft) is the other way to toggle it.
    // Deliberately HEAD-COMMIT-ONLY (not last-declaration-wins): a stale
    // `Draft: true` from an earlier commit must not re-draft a published Change
    // on every later push.
    const draftTrailer = head?.draft;
    // Change description: the commit bodies with their trailer blocks stripped
    // (8KB cap). Distinct from `intent` (the one-line Intent: trailer). Powers
    // the Review Brief header +, later, the conformance-verify spec hierarchy.
    const description = describeCommits(commits);

    // #196: EVERY authoritative read below diffs from the MERGE BASE, matching
    // the diff the reviewer is shown (routes/changes.ts). Diffing the default-
    // branch TIP attributed every file trunk changed since the fork point to
    // the Change — inflating risk to critical, forcing human review and killing
    // auto-merge on files that are not in the on-screen diff. When the branch
    // is current, merge base == tip and nothing changes.
    const diffBase = await resolveDiffBase(git, namespace, repoName, defaultBranch, r.newSha);

    // Authoritative changed paths from git — the merge gate's sensitive-path
    // forcing AND the hard secret scan read these, never the agent-declared
    // `Scope:` trailer (which an agent could under-report to dodge a
    // code-review requirement — or, before #130, to hide a credential from the
    // one gate that keeps it out of history). Hoisted above the scan so the
    // gate sees git's list; the SINGLE numstat is reused below by the risk
    // engine and the Review Brief synthesis (no extra git process).
    let changedPaths: string[] = [];
    // Per-file line counts (hoisted so the Review Brief synthesis below can
    // reuse the single numstat rather than spawning git again).
    let statFiles: Array<{ path: string; additions: number; deletions: number }> = [];
    let stat: DiffStats | null = null;
    try {
      stat = await git.numstat(namespace, repoName, diffBase, r.newSha);
      changedPaths = stat.paths;
      statFiles = stat.files;
    } catch (e) { log("warn", "numstat_failed", { repoId, err: (e as Error).message }); }

    // Scope: union of declared scopes, fallback to diff-derived. ADVISORY —
    // it drives Review-Focus, where author intent is the point. It is NOT an
    // input to the secret gate, and (#205) it can only WIDEN — never narrow —
    // the path set the agent scope gate below checks.
    let scope = Array.from(new Set(allTrailers.flatMap(t => t.scope)));
    if (scope.length === 0) {
      try { scope = await git.diffNameOnly(namespace, repoName, diffBase, r.newSha); } catch {}
    }
    // Only if git gave us nothing at all (numstat failed / empty diff) does the
    // declared scope stand in for the stored path list — the pre-existing
    // degraded fallback, kept so a git hiccup can't blank the sensitive-path
    // forcing the merge gate reads off `changes.changedPaths`.
    if (changedPaths.length === 0) changedPaths = scope;

    // One bulk read (single git process) serves both the inline-REVIEW scan
    // and the secret scan — these used to spawn git twice per scope file. The
    // read covers the declared scope (inline `// REVIEW:` flags are author
    // intent) PLUS every git-changed path the scanner will look at; ignored
    // extensions/directories are filtered out so widening the gate does not
    // widen the read.
    const declared = new Set(scope);
    const scanOnlyPaths = changedPaths.filter(p => !declared.has(p) && isScannablePath(p));
    const scopeContents = await git.filesAt(namespace, repoName, r.newSha, [...scope, ...scanOnlyPaths]);

    // Review-Focus from trailers + inline comments in the DECLARED scope (the
    // scan-only paths above are gate input, not focus input).
    const inline = [];
    for (const p of scope) {
      const contents = scopeContents.get(p);
      if (contents) inline.push(...extractInlineReviewComments(p, contents));
    }
    const reviewFocus = mergeFocus(allTrailers.flatMap(t => t.reviewFocus), inline);
    const closes = Array.from(new Set(allTrailers.flatMap(t => t.closes)));

    // Hard secret-scan: any match rejects the push with a clear error. Users
    // can whitelist by `.clawhub/allow-secret: <kind>` if truly intentional
    // (not implemented here; treated as an opt-in extension). Driven off
    // `changedPaths` (git) — `scope` is appended only so a declared-but-not-in-
    // diff path is still covered, never to NARROW the list.
    const secretScan = scanPushedFiles([...changedPaths, ...scope], scopeContents);
    metrics.inc("clawhub_secret_scan_files_total", {}, secretScan.scanned);
    if (secretScan.truncated) {
      // Never silent (#118 / #130): a bound that hides files is an announced
      // bound. Alertable — a real push should never reach 64 MiB of text.
      metrics.inc("clawhub_secret_scan_truncated_total", { repo: repoName });
      log("warn", "secret_scan_truncated", { repoId, branch, scanned: secretScan.scanned, unscanned: secretScan.unscanned });
    }
    if (secretScan.hits.length) {
      const hit = secretScan.hits[0];
      metrics.inc("clawhub_secret_scan_rejected_total", { kind: hit.kind });
      log("warn", "secret_scan_rejected", { repoId, branch, kind: hit.kind, path: hit.path, line: hit.line });
      // REVERT the ref — the same compare-and-swap the branch-protection path
      // above uses. This scan runs POST-receive, so the credential-bearing ref
      // is already on the server: leaving it there means a "rejected" push
      // still hands the secret to anyone who can fetch the branch. And because
      // `priorHeads` is read from the `branches` TABLE (git-http.ts), which a
      // rejected push never writes, the ref is re-discovered as NEW on every
      // later push — so one poisoned branch would throw here forever and wedge
      // every subsequent Change in the repo (observed live before this).
      //
      // #195 (the #130 follow-up): on the magic-ref path (`refs/for/<branch>`,
      // the path every agent pushes on) `r.ref` is a SYNTHETIC
      // `refs/heads/magic/...` name that never exists on disk — `admitMagicRefs`
      // allocated the Change row and wrote `refs/clawhub/changes/<id>` BEFORE
      // this pipeline ran, so the update-ref revert was a no-op and the
      // credential stayed fetchable (and rendered by the change diff route)
      // forever, hanging off a zombie placeholder Change. Retract the CHANGE
      // instead: under the same lock admitMagicRefs allocated it with, delete
      // the changes row + the synthetic branches row + undo the stats bump,
      // then drop the change ref on disk so the commit becomes unreachable.
      // Dispatch on the ADMISSION FACT (r.viaMagicRef, stamped by the runner
      // when it synthesizes the ref after admitMagicRefs), NOT the branch name:
      // "magic/" is not a reserved prefix, so a real refs/heads/magic/x branch
      // must take the ordinary CAS-revert arm below — routing it here would
      // skip the on-disk revert (the secret stays fetchable while the push is
      // audited "rejected"), delete a legitimate Change row on a second push,
      // and re-throw on every later job as the ref is re-discovered as new.
      if (r.viaMagicRef) {
        // synthBranch = magic/<target>/<sha12>; <target> may itself contain "/".
        const magicTarget = branch.slice("magic/".length, branch.lastIndexOf("/"));
        let retractedChangeId: string | null = null;
        try {
          await withChangeUpsertLock(db, repoId, `magic:${magicTarget}`, async tx => {
            const row = (await tx.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1))[0];
            if (!row) return;
            await tx.delete(changes).where(eq(changes.id, row.id));
            await tx.delete(branches).where(and(eq(branches.repoId, repoId), eq(branches.name, branch)));
            // Undo the changesOpened bump the ref-rewriter applied for this push.
            if (agentId) {
              await tx.execute(sql`update agents set stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{changesOpened}', to_jsonb(greatest(0, coalesce((stats->>'changesOpened')::int, 0) - 1))) where id = ${agentId}`);
            }
            retractedChangeId = row.id;
          });
          if (retractedChangeId) {
            for (const ref of [`refs/clawhub/changes/${retractedChangeId}`, `refs/changes/${retractedChangeId}`]) {
              try { await git.open(namespace, repoName).raw(["update-ref", "-d", ref]); } catch { /* ref may not exist yet */ }
            }
            metrics.inc("clawhub_secret_scan_retracted_total", { kind: hit.kind });
          }
        } catch (e) {
          log("warn", "secret_scan_revert_failed", { repoId, branch, err: (e as Error).message });
        }
      } else {
        try {
          await git.open(namespace, repoName).raw(/^0+$/.test(r.oldSha)
            ? ["update-ref", "-d", r.ref, r.newSha]       // the push CREATED the branch → drop it
            : ["update-ref", r.ref, r.oldSha, r.newSha]); // else roll back to the prior head
        } catch (e) {
          log("warn", "secret_scan_revert_failed", { repoId, branch, err: (e as Error).message });
        }
      }
      // The pusher's `git push` already returned success (post-push is async),
      // so the rejection needs an out-of-band trail the repo owner can see.
      await getAuditLog(db).record({
        repoId, actorKind, actorId, category: "secret",
        action: "secret_scan.push_rejected", metadata: { branch, kind: hit.kind, path: hit.path, line: hit.line },
      });
      throw new ForbiddenError(`secret_detected:${hit.kind}:${hit.path}:${hit.line}`, "secret_scan");
    }

    // Trial merge.
    let hasConflicts = false;
    try { hasConflicts = (await git.trialMerge(namespace, repoName, defaultBranch, r.newSha)).conflicts; } catch {}

    const trailers = allTrailers.reduce<Record<string, string[]>>((acc, t) => {
      for (const [k, v] of Object.entries(t.raw)) (acc[k] ??= []).push(...v);
      return acc;
    }, {});

    // Compute risk from the diff vs the merge base — reusing the ONE numstat
    // taken above the secret gate (paths + line counts, no second git process).
    // Shared derivation (change-derivation.ts) so the cross-repo-proposal
    // accept path computes the identical thing (#127).
    const riskAssessment = await deriveComputedRisk(db, {
      repoId, declared: risk, changedPaths, stat,
      authorAgentId: agentId, authorUserId: userId,
    });
    const computedRisk = riskAssessment.risk;
    const riskReasons = riskAssessment.reasons;

    // Agent scope enforcement — agent-only (humans have no per-identity path
    // allowlist / risk ceiling). Decided on the GIT-derived facts, never the
    // agent's own trailers (#205, the same bug class #130 fixed for the secret
    // gate next door): the path check gets the union of git's changedPaths and
    // the declared scope (a `Scope:` trailer can only WIDEN the checked set,
    // never narrow it — declaring `Scope: README.md` used to satisfy both list
    // checks while shipping deploy/**), and the ceiling gets the EFFECTIVE risk,
    // max(declared, computed) — the same value the merge gate floors on. Sits
    // below the risk computation for exactly that reason. When numstat failed,
    // changedPaths was back-filled from the declared scope above — self-reported
    // data again — so a configured quota fails CLOSED on it (pathsDegraded).
    if (agentId) {
      // #196: the branch-creating arm (all-zeros oldSha — every magic-ref push,
      // synthesized by post-push-runner) measures LOC from the merge base
      // (diffBase), not the trunk tip, so trunk's own commits never count
      // against the agent's cap.
      const loc = /^0+$/.test(r.oldSha)
        ? await git.countLocBetween(namespace, repoName, diffBase, r.newSha)
        : await git.countLocBetween(namespace, repoName, r.oldSha, r.newSha);
      await enforceScope(db, agentId, {
        paths: Array.from(new Set([...changedPaths, ...scope])),
        risk: computedRisk,
        loc,
        pathsDegraded: !stat,
      });
    }

    // Deterministic focus floor (M1): synthesize a Review Brief from the diff so
    // a trailer-less push never renders the empty-focus state. Best-effort — a
    // failure leaves reviewBrief null and the UI falls back to today's layout.
    // Kill switch + the D3 hard deadline live in change-derivation.ts (shared
    // with the cross-repo-proposal accept, #127).
    const reviewBrief = await deriveReviewBrief(db, git, {
      namespace, repoName, repoId, diffBase, head: r.newSha, changedPaths, statFiles,
    });

    // e2e verification TIER — server-derived (services/verify-tier.ts), the single
    // source of truth that demotes the heavy DinD boot to opt-in. The FLOOR comes
    // from the diff paths + repo policy + effective risk (a Change can't downgrade
    // itself below it, must-fix #2); the shape from the head .clawhub/verify.yml.
    // Best-effort: a failure leaves it null and the dispatch falls back safely.
    const { verifyTier, verifyTierReason } = await deriveVerifyTier(db, git, {
      namespace, repoName, repoId, head: r.newSha, changedPaths, effectiveRisk: computedRisk,
    });

    // v3 wrappers: for an AGENT push, record the sponsoring human (the git
    // author-vs-committer pattern) — the agent's associated or creating user.
    // Null for human pushes and for headless agents with no governing human.
    let onBehalfOfUserId: string | null = null;
    if (agentId) {
      const sponsor = (await db.select({ associatedUserId: agents.associatedUserId, createdByUserId: agents.createdByUserId })
        .from(agents).where(eq(agents.id, agentId)).limit(1))[0];
      onBehalfOfUserId = sponsor?.associatedUserId ?? sponsor?.createdByUserId ?? null;
    }

    // #121: does this repo dismiss approvals when the head moves? Default TRUE
    // (normalizeMergePolicy), so a repo with no policy row still fails closed.
    const dismissStale = normalizeMergePolicy(
      (await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0]?.mergePolicy,
    ).dismissStaleApprovals !== false;

    // Serialize the branch + Change upsert per (repo, branch) so two concurrent
    // pushes to the same branch don't lose trailer metadata. The advisory lock
    // is released automatically at COMMIT/ROLLBACK.
    const upsertResult = await withChangeUpsertLock(db, repoId, branch, async tx => {
      await tx.insert(branches).values({ repoId, name: branch, headCommit: r.newSha })
        .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });

      const existingRows = await tx.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1);
      if (existingRows[0]) {
        // A `Draft:` trailer (true/false) overrides; absent preserves the current
        // state (so an API/CLI draft toggle isn't clobbered by a no-trailer push).
        const nextIsDraft = draftTrailer ?? existingRows[0].isDraft;
        await tx.update(changes).set({
          headCommit: r.newSha, intent, description, risk, computedRisk, riskReasons, scope, changedPaths, reviewFocus, reviewBrief, trailers,
          verifyTier, verifyTierReason, onBehalfOfUserId,
          // A new push is a new diff — void any "merge when ready" arm (the human
          // approved the PRIOR head, not this one; the armedAtCommit guard also blocks
          // it, but clearing keeps the UI honest).
          autoMerge: null,
          hasConflicts, isDraft: nextIsDraft, status: nextIsDraft ? "draft" : "pending", updatedAt: new Date(),
        }).where(eq(changes.id, existingRows[0].id));

        // #121 — a new head is a new diff, so the APPROVALS of the old one die
        // with it, in the SAME transaction that moves the head (no window where
        // the gate sees the new commit beside the old approval). A re-push of the
        // SAME sha is not a new diff and dismisses nothing. See stale-approvals.ts
        // for exactly what is (and is not) swept.
        if (dismissStale && existingRows[0].headCommit !== r.newSha) {
          const n = await dismissStaleApprovals(tx, existingRows[0].id, r.newSha);
          if (n) log("info", "stale_approvals_dismissed", { repoId, changeId: existingRows[0].id, count: n, newHead: r.newSha });
        }
        return { changeId: existingRows[0].id, isNew: false };
      }
      const newIsDraft = draftTrailer ?? false;
      const ins = await tx.insert(changes).values({
        repoId, branch, headCommit: r.newSha, intent, description, risk, computedRisk, riskReasons,
        scope, changedPaths, reviewFocus, reviewBrief, trailers, hasConflicts, verifyTier, verifyTierReason,
        isDraft: newIsDraft, status: newIsDraft ? "draft" : "pending",
        openedByAgentId: agentId, openedByUserId: userId, onBehalfOfUserId,
      }).returning();
      // changesOpened is an agent productivity stat — only agents accrue it.
      if (agentId) {
        await tx.execute(sql`update agents set stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{changesOpened}', to_jsonb(coalesce((stats->>'changesOpened')::int, 0) + 1)) where id = ${agentId}`);
      }
      return { changeId: ins[0].id, isNew: true };
    });
    const changeId = upsertResult.changeId;
    const existing = upsertResult.isNew ? [] : [{ id: changeId }];

    // A new push to an EXISTING change moved its head — cancel any in-flight CI /
    // verify / review run still pinned to the OLD head (a stale diff must not keep
    // running or attest on a diff that no longer exists). The fresh runs queued
    // below target r.newSha and are untouched.
    if (!upsertResult.isNew) {
      await cancelSupersededHeadRuns(db, events, changeId, r.newSha).catch(() => {});
    }

    await changeRefs.set(namespace, repoName, changeId, r.newSha);

    // Record each `Closes: #N` claim as an N:M issue↔change link (#13), flagged
    // `closes: true` so the merge path can tell a trailer claim from a manual
    // "related work" link (#137).
    //
    // This deliberately does NOT touch the `issues` row. It used to stamp
    // `issues.closingChangeId = changeId` unconditionally — and since the whole
    // close/reopen contract matched on that single scalar, a SECOND unmerged
    // branch trailing the same `Closes: #7` stole the pointer: the first Change
    // then merged with a WHERE that matched zero rows, leaving the issue open
    // with no error and no log. (The Loop's daily cadence manufactures exactly
    // that duplicate on its own — the developer re-grabs the still-open issue
    // and re-implements it forever.) The pointer is now written only by the
    // merge that actually closes the issue; a push claims nothing.
    if (closes.length) {
      const linked = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.repoId, repoId), inArray(issues.number, closes)));
      if (linked.length) {
        // A link may already exist as a MANUAL one — upgrade it to a closing
        // link rather than dropping the trailer's claim on the floor.
        await db.insert(issueChanges).values(linked.map(i => ({ issueId: i.id, changeId, repoId, closes: true })))
          .onConflictDoUpdate({ target: [issueChanges.issueId, issueChanges.changeId], set: { closes: true } });
      }
    }

    // Queue CI runs for push-triggered pipelines (on: merge ones fire from
    // ChangeService.merge instead) and announce each via ci.run.queued — the
    // runner daemon picks work up from that event. With no push pipelines,
    // mark CI skipped so the UI doesn't show a gate nothing will ever run.
    // Filter on the persisted triggerKind column, not pipelineTrigger(yaml):
    // schedule/event pipelines report "push" from the legacy helper, so the old
    // filter would wrongly fire them on every Change push. The column is the
    // source of truth (set from the YAML `on:` at pipeline upsert).
    const pipelines = (await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, repoId), eq(ciPipelines.enabled, true))))
      .filter(p => p.triggerKind === "push");
    if (pipelines.length > 0) {
      // Reset ciStatus so a NEW head never inherits the PRIOR head's status — a
      // stale 'success' from head A must not let head B merge before B's own CI
      // runs (recomputeChangeCiStatus is head-scoped, but it only fires on a run's
      // terminal report; nothing else clears the column on a re-push). Done BEFORE
      // dispatch so a fast runner's terminal recompute can't be overwritten. New
      // changes already default 'pending'; this covers the re-push case.
      await db.update(changes).set({ ciStatus: "pending" }).where(eq(changes.id, changeId));
    }
    for (const p of pipelines) {
      const runnerToken = randomToken(18);
      // Capability-graded execution: a repo runs CI steps on the runner HOST only if it
      // is operator-allowlisted AND its pipeline requested `execution: host`; everyone
      // else runs contained. Resolved SERVER-SIDE and stamped into the payload — the
      // runner obeys this, never the YAML. Re-parse the yaml so a fresh `execution:host`
      // takes effect without waiting for a triggerConfig re-sync. See ci-host-exec.ts.
      const execution = resolveCiExecution(parsePipelineTrigger(p.yaml).config.execution, namespace, repoName, repoId);
      const run = (await db.insert(ciRuns).values({ repoId, changeId, pipelineId: p.id, runnerToken, origin: "push", triggerDepth: 0, commit: r.newSha, ...ciSchedulingStamp("push") }).returning())[0];
      await events.publish({
        type: "ci.run.queued", repoId, changeId, actorKind, actorId,
        // changeId in the PAYLOAD so the runner can fetch the Change ref before
        // checkout: a magic-ref push (refs/for/<branch>) lands the head ONLY on
        // refs/clawhub/changes/<id>, which a clone doesn't fetch — without this the
        // push-pipeline `checkout` fails "reference is not a tree". (The verify path
        // already carried it; this closes the same gap for push-triggered CI.)
        payload: { runId: run.id, repoNs: namespace, repoName, commit: r.newSha, changeId, pipelineYaml: p.yaml, runnerToken, execution },
      });
    }
    if (pipelines.length === 0) {
      await db.update(changes).set({ ciStatus: "skipped" }).where(eq(changes.id, changeId));
    }

    // Public activity feed (for /trending, RSS, feed).
    const repoRow = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
    if (repoRow?.isPublic) {
      await db.insert(publicActivity).values({
        repoId,
        agentId,
        userId,
        kind: existing[0] ? "change.updated" : "change.opened",
        changeId,
        summary: intent,
      });
      // Maintain changesCount on repo for trending ranking.
      await db.update(repositories).set({ changesCount: (repoRow.changesCount ?? 0) + 1 }).where(eq(repositories.id, repoId));
    }

    await events.publish({
      type: existing[0] ? "change.updated" : "change.opened",
      repoId, changeId, actorKind, actorId,
      payload: { branch, intent, risk, hasConflicts, scope, reviewFocus, actorName },
    });

    // Memory capture: a change's Intent trailer is already-distilled knowledge
    // (the author explained the work) — record it as a repo episode with the diff
    // paths so reflect has raw material and path retrieval sees this area is hot.
    // Called on EVERY change upsert, not just `!existing[0]`: a magic-ref push
    // (refs/for/<branch>) pre-creates the Change in the ref-rewriter, so post-push
    // always sees it as existing — the same reason CHANGE_EVENTS treats
    // change.updated as change.opened. captureChangeOpened's (kind, title) dedup
    // (title embeds the change id + intent) makes repeat pushes no-ops unless the
    // intent itself changed. Best-effort inside capture; never blocks the push.
    await captureChangeOpened(db, {
      id: changeId, repoId, intent, branch,
      changedPaths, openedByAgentId: agentId,
    }, { scope: scope.join(", ") });

    // Run SAST asynchronously — never block the push. NOTE: this loop tail is
    // NON-DEFAULT-BRANCH ONLY (the default-branch handler `continue`d above) —
    // default-branch maintenance (dep-scan, code index, Graphify) lives in that
    // handler's detached block. A `branch === defaultBranch` gate here is dead
    // code, and the dead block it guarded silently orphaned the code index for
    // two rescue passes (#118, #186) before being removed.
    (async () => {
      try {
        const sastResult = await sastScan(db, git, {
          namespace, repo: repoName, repoId, changeId,
          base: defaultBranch, head: r.newSha, scope,
        });
        if (sastResult.findings > 0) metrics.inc("clawhub_sast_findings_total", { repo: repoName }, sastResult.findings);
      } catch (e) { log("warn", "sast_scan_failed", { repoId, err: (e as Error).message }); }
    })();
  }
}
