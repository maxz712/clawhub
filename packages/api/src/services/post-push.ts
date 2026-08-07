import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, agents, branches, changes, ciPipelines, ciRuns, issues, issueChanges, publicActivity, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { cancelSupersededHeadRuns } from "./run-staleness.js";
import { ciSchedulingStamp } from "./job-scheduling.js";
import { parseTrailers, describeCommits } from "./trailer-parser.js";
import { computeRisk, isGeneratedFile } from "./risk-engine.js";
import { synthesizeReviewBrief, isSensitivePath, type ReviewBrief } from "./focus-synthesis.js";
import { selectVerifyTier, parseVerifyYmlInfo, type VerifyTierPolicy } from "./verify-tier.js";
import { extractInlineReviewComments, mergeFocus } from "./focus-parser.js";
import { randomToken } from "./auth.js";
import { enforceRate, enforceScope } from "./agent-scope.js";
import { ForbiddenError } from "./errors.js";
import { scanChange as sastScan } from "./sast.js";
import { scanRepoHead } from "./dep-scan.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";
import { isAgentKilled } from "./kill-switch.js";
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
        if (prot.blockDeletion) throw new ForbiddenError("branch protection forbids deletion", "branch_protection");
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
        try {
          const mb = await git.open(namespace, repoName).raw(["merge-base", "--is-ancestor", r.oldSha, r.newSha]);
          // is-ancestor returns 0 exit on success; simple-git throws on non-zero.
        } catch {
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
      })();
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
    // `Draft: true/false` on the head commit controls the Change's draft state so a
    // push can keep WIP unreviewed or publish it. undefined (no trailer) preserves
    // the existing state — the API/CLI (markDraft) is the other way to toggle it.
    const draftTrailer = head?.draft;
    // Change description: the commit bodies with their trailer blocks stripped
    // (8KB cap). Distinct from `intent` (the one-line Intent: trailer). Powers
    // the Review Brief header +, later, the conformance-verify spec hierarchy.
    const description = describeCommits(commits);

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
    let stat: { paths: string[]; additions: number; deletions: number; files: typeof statFiles } | null = null;
    try {
      stat = await git.numstat(namespace, repoName, defaultBranch, r.newSha);
      changedPaths = stat.paths;
      statFiles = stat.files;
    } catch (e) { log("warn", "numstat_failed", { repoId, err: (e as Error).message }); }

    // Scope: union of declared scopes, fallback to diff-derived. ADVISORY —
    // it drives Review-Focus + the agent path allowlist, where author intent is
    // the point. It is NOT an input to the secret gate.
    let scope = Array.from(new Set(allTrailers.flatMap(t => t.scope)));
    if (scope.length === 0) {
      try { scope = await git.diffNameOnly(namespace, repoName, defaultBranch, r.newSha); } catch {}
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
      // KNOWN GAP (follow-up, not widened here): on the magic-ref path
      // (`refs/for/<branch>`) `r.ref` is a SYNTHETIC `refs/heads/magic/...`
      // name that never exists on disk — `admitMagicRefs` allocates the Change
      // row and writes `refs/clawhub/changes/<id>` BEFORE this pipeline runs,
      // so there the delete is a no-op and the commit stays reachable through
      // the change ref. Reverting that needs the change id and a Change-row
      // retraction, which is a larger surface than this fix.
      try {
        await git.open(namespace, repoName).raw(/^0+$/.test(r.oldSha)
          ? ["update-ref", "-d", r.ref, r.newSha]       // the push CREATED the branch → drop it
          : ["update-ref", r.ref, r.oldSha, r.newSha]); // else roll back to the prior head
      } catch (e) {
        log("warn", "secret_scan_revert_failed", { repoId, branch, err: (e as Error).message });
      }
      throw new ForbiddenError(`secret_detected:${hit.kind}:${hit.path}:${hit.line}`, "secret_scan");
    }

    // Trial merge.
    let hasConflicts = false;
    try { hasConflicts = (await git.trialMerge(namespace, repoName, defaultBranch, r.newSha)).conflicts; } catch {}

    // Agent scope enforcement (after we know the paths + risk). Agent-only —
    // humans have no per-identity path allowlist / risk ceiling.
    if (agentId) {
      const loc = /^0+$/.test(r.oldSha)
        ? await git.countLocBetween(namespace, repoName, defaultBranch, r.newSha)
        : await git.countLocBetween(namespace, repoName, r.oldSha, r.newSha);
      await enforceScope(db, agentId, { paths: scope, risk, loc });
    }

    const trailers = allTrailers.reduce<Record<string, string[]>>((acc, t) => {
      for (const [k, v] of Object.entries(t.raw)) (acc[k] ??= []).push(...v);
      return acc;
    }, {});

    // Compute risk from the diff vs the target branch — reusing the ONE numstat
    // taken above the secret gate (paths + line counts, no second git process).
    let riskAssessment = { risk, reasons: [] as string[] };
    try {
      if (!stat) throw new Error("numstat_unavailable"); // logged as risk_compute_failed; numstat_failed already fired
      // Track-record floor: prior rolled-back Changes by THIS author in THIS
      // repo bump risk. Counted per author identity — agent or human.
      const priorRollbacks = (await db.select({ id: changes.id }).from(changes).where(and(
        eq(changes.repoId, repoId),
        agentId ? eq(changes.openedByAgentId, agentId) : eq(changes.openedByUserId, userId!),
        eq(changes.status, "rolled_back"),
      ))).length;
      // Size metric excludes generated/derived files (lockfiles, snapshots, build
      // output). A 1,983-line package-lock.json must not push a normal first
      // commit to "very large change" → HIGH and block the solo workflow. The
      // full changedPaths above are still used for the path-floor logic.
      let sizeAdds = stat.additions, sizeDels = stat.deletions;
      for (const f of stat.files) {
        if (isGeneratedFile(f.path)) { sizeAdds -= f.additions; sizeDels -= f.deletions; }
      }
      riskAssessment = computeRisk({
        declared: risk,
        changedPaths,
        additions: Math.max(0, sizeAdds),
        deletions: Math.max(0, sizeDels),
        agentPriorRollbacks: priorRollbacks,
      });
    } catch (e) { log("warn", "risk_compute_failed", { repoId, err: (e as Error).message }); }
    const computedRisk = riskAssessment.risk;
    const riskReasons = riskAssessment.reasons;

    // Deterministic focus floor (M1): synthesize a Review Brief from the diff so
    // a trailer-less push never renders the empty-focus state. Best-effort — a
    // failure leaves reviewBrief null and the UI falls back to today's layout.
    // Kill switch: CLAWHUB_DISABLE_FOCUS_SYNTHESIS=1. Only the small sensitive
    // subset of paths gets a second git process (diffHunks); everything else is
    // pure ranking over the numstat we already have.
    let reviewBrief: ReviewBrief | null = null;
    if (process.env.CLAWHUB_DISABLE_FOCUS_SYNTHESIS !== "1") {
      // HARD DEADLINE (D3, 400ms): synthesis runs on the serial post-push worker,
      // and its only slow leg — git.diffHunks, a subprocess on the (possibly
      // contended/sharded) git tier — would otherwise head-of-line-block EVERY
      // queued push behind one slow diff. Past the deadline we leave the brief null
      // (the UI falls back to today's layout) and move on. The kill switch above is
      // global; this is the per-push safety valve the plan decided on.
      const DEADLINE_MS = Number(process.env.CLAWHUB_FOCUS_SYNTHESIS_DEADLINE_MS ?? 400);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reviewBrief = await Promise.race<ReviewBrief>([
          (async (): Promise<ReviewBrief> => {
            const sensitivePaths = changedPaths.filter(isSensitivePath).slice(0, 40);
            const sensitiveHunks = sensitivePaths.length
              ? await git.diffHunks(namespace, repoName, defaultBranch, r.newSha, sensitivePaths)
              : [];
            // Rollback episodes overlapping the changed paths — the platform's own
            // recorded "this area burned us before" signal (memory-capture rows).
            let rollbackEpisodes: Array<{ paths: string[]; intent: string; reason?: string | null }> = [];
            try {
              const rows = await db.select({ body: agentMemories.body, facts: agentMemories.facts, title: agentMemories.title })
                .from(agentMemories)
                .where(and(
                  eq(agentMemories.scopeKey, `repo:${repoId}`),
                  eq(agentMemories.kind, "failure"),
                  isNull(agentMemories.validTo),
                )).limit(50);
              const changedSet = new Set(changedPaths);
              rollbackEpisodes = rows
                .map(row => {
                  const facts = (row.facts ?? {}) as { paths?: unknown };
                  const paths = Array.isArray(facts.paths) ? facts.paths.filter((p): p is string => typeof p === "string") : [];
                  return { paths, intent: (row.title ?? "").replace(/^Rolled back:\s*/, ""), reason: null };
                })
                .filter(ep => ep.paths.some(p => changedSet.has(p)));
            } catch (e) { log("warn", "focus_rollback_lookup_failed", { repoId, err: (e as Error).message }); }
            return synthesizeReviewBrief({
              files: statFiles.length ? statFiles : changedPaths.map(p => ({ path: p, additions: 0, deletions: 0 })),
              sensitiveHunks,
              rollbackEpisodes,
            });
          })(),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("focus_synthesis_deadline")), DEADLINE_MS); }),
        ]);
        metrics.inc("clawhub_focus_synthesis_total", { result: reviewBrief.derivedFocus.length ? "flagged" : "empty" });
      } catch (e) {
        if ((e as Error).message === "focus_synthesis_deadline") metrics.inc("clawhub_focus_synthesis_total", { result: "timeout" });
        else log("warn", "focus_synthesis_failed", { repoId, err: (e as Error).message });
      } finally { if (timer) clearTimeout(timer); }
    }

    // e2e verification TIER — server-derived (services/verify-tier.ts), the single
    // source of truth that demotes the heavy DinD boot to opt-in. The FLOOR comes
    // from the diff paths + repo policy + effective risk (a Change can't downgrade
    // itself below it, must-fix #2); the shape from the head .clawhub/verify.yml.
    // Best-effort: a failure leaves it null and the dispatch falls back safely.
    let verifyTier: string | null = null, verifyTierReason: string | null = null;
    try {
      const verifyRaw = (await git.filesAt(namespace, repoName, r.newSha, [".clawhub/verify.yml"])).get(".clawhub/verify.yml") ?? null;
      const mp = ((await db.select({ mergePolicy: repositories.mergePolicy }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0]?.mergePolicy ?? {}) as { verifyTier?: VerifyTierPolicy };
      const decision = selectVerifyTier({
        changedPaths,
        verifyYml: parseVerifyYmlInfo(verifyRaw),
        policy: mp.verifyTier ?? {},
        effectiveRisk: computedRisk,
      });
      verifyTier = decision.tier;
      verifyTierReason = decision.reason;
    } catch (e) { log("warn", "verify_tier_failed", { repoId, err: (e as Error).message }); }

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

    // Link Closes: issues (pending until merge).
    if (closes.length) {
      await db.update(issues).set({ closingChangeId: changeId, updatedAt: new Date() })
        .where(and(eq(issues.repoId, repoId), inArray(issues.number, closes)));
      // Also create explicit N:M issue↔change links so the relationship is
      // visible on both sides, not just via the single closingChangeId (#13).
      const linked = await db.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.repoId, repoId), inArray(issues.number, closes)));
      if (linked.length) {
        await db.insert(issueChanges).values(linked.map(i => ({ issueId: i.id, changeId, repoId }))).onConflictDoNothing();
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

    // Policy-as-code: adopt .clawhub/policies/merge.yml ONLY from the default
    // branch — i.e. after a policy change has itself been reviewed and merged.
    // Reading it from a feature-branch head would let an agent push a
    // permissive policy and have that same push's Change evaluated under it
    // (self-approve, gate disabled). Because the default policy forces human
    // code review on `.clawhub/policies/**`, a policy change can only land
    // through a human — and only then does it take effect.
    if (branch === defaultBranch) {
      try {
        const inRepoPolicy = await readRepoPolicy(git, namespace, repoName, r.newSha);
        if (inRepoPolicy) {
          await db.update(repositories).set({ mergePolicy: inRepoPolicy, updatedAt: new Date() }).where(eq(repositories.id, repoId));
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

    // Run SAST + dep-scan + code index refresh asynchronously — never block the push.
    (async () => {
      try {
        const sastResult = await sastScan(db, git, {
          namespace, repo: repoName, repoId, changeId,
          base: defaultBranch, head: r.newSha, scope,
        });
        if (sastResult.findings > 0) metrics.inc("clawhub_sast_findings_total", { repo: repoName }, sastResult.findings);
      } catch (e) { log("warn", "sast_scan_failed", { repoId, err: (e as Error).message }); }

      if (branch === defaultBranch) {
        try {
          const { findings } = await scanRepoHead(db, git, {
            namespace, repo: repoName, repoId, commit: r.newSha,
            openIssueCreator: { kind: actorKind, id: actorId },
          });
          if (findings > 0) metrics.inc("clawhub_vuln_findings_total", { repo: repoName }, findings);
        } catch (e) { log("warn", "dep_scan_failed", { repoId, err: (e as Error).message }); }

        try {
          // Prior tip makes the reindex incremental: only files in the push.
          await indexRepoAtCommit(db, git, namespace, repoName, repoId, r.newSha, { sinceCommit: r.oldSha });
        } catch (e) { log("warn", "code_index_failed", { repoId, err: (e as Error).message }); }

        // v3 P6 — Graphify: the structural code graph, same incremental path.
        // Default-on per repo; kill switch CLAWHUB_DISABLE_CODE_GRAPH=1.
        try {
          if (await graphifyEnabledForRepo(db, repoId)) {
            await buildCodeGraphAtCommit(db, git, namespace, repoName, repoId, r.newSha, { sinceCommit: r.oldSha });
          }
        } catch (e) { log("warn", "code_graph_failed", { repoId, err: (e as Error).message }); }
      }
    })();
  }
}
