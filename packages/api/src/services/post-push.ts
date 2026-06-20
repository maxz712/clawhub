import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, changes, ciPipelines, ciRuns, issues, issueChanges, publicActivity, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { parseTrailers } from "./trailer-parser.js";
import { computeRisk, isGeneratedFile } from "./risk-engine.js";
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
import { indexRepoAtCommit } from "./code-index.js";
import { scanFile } from "./secret-scan.js";
import { withChangeUpsertLock } from "./repo-lock.js";

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

    // Kill-switch: reject push from a suspended agent.
    if (await isAgentKilled(db, agentId)) {
      throw new ForbiddenError("agent_kill_switch_engaged", "kill_switch");
    }

    // Rate-limit + per-agent scope enforcement.
    await enforceRate(db, agentId, "push");

    // Default-branch push (including the push that creates it): no Change row,
    // but still serialize the branch update through the advisory lock so
    // concurrent pushes to main do not lose the post-push event ordering.
    if (branch === defaultBranch) {
      await withChangeUpsertLock(db, repoId, branch, async tx => {
        await tx.insert(branches).values({ repoId, name: branch, headCommit: r.newSha })
          .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });
      });
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

    // One bulk read (single git process) serves both the inline-REVIEW scan
    // and the secret scan — these used to spawn git twice per scope file.
    const scopeContents = await git.filesAt(namespace, repoName, r.newSha, scope);

    // Review-Focus from trailers + inline comments in changed files.
    const inline = [];
    for (const [p, contents] of scopeContents) {
      if (contents) inline.push(...extractInlineReviewComments(p, contents));
    }
    const reviewFocus = mergeFocus(allTrailers.flatMap(t => t.reviewFocus), inline);
    const closes = Array.from(new Set(allTrailers.flatMap(t => t.closes)));

    // Hard secret-scan: any match rejects the push with a clear error. Users
    // can whitelist by `.clawhub/allow-secret: <kind>` if truly intentional
    // (not implemented here; treated as an opt-in extension).
    for (const p of scope.slice(0, 40)) {
      const content = scopeContents.get(p);
      if (!content) continue;
      const hits = scanFile(p, content);
      if (hits.length) {
        throw new ForbiddenError(`secret_detected:${hits[0].kind}:${hits[0].path}:${hits[0].line}`, "secret_scan");
      }
    }

    // Trial merge.
    let hasConflicts = false;
    try { hasConflicts = (await git.trialMerge(namespace, repoName, defaultBranch, r.newSha)).conflicts; } catch {}

    // Agent scope enforcement (after we know the paths + risk).
    try {
      const loc = /^0+$/.test(r.oldSha)
        ? await git.countLocBetween(namespace, repoName, defaultBranch, r.newSha)
        : await git.countLocBetween(namespace, repoName, r.oldSha, r.newSha);
      await enforceScope(db, agentId, { paths: scope, risk, loc });
    } catch (e) {
      throw e;
    }

    const trailers = allTrailers.reduce<Record<string, string[]>>((acc, t) => {
      for (const [k, v] of Object.entries(t.raw)) (acc[k] ??= []).push(...v);
      return acc;
    }, {});

    // Compute risk from the diff vs the target branch — one numstat call yields
    // paths + line counts. The diff-derived `scope` is reused when the agent
    // declared none, so prefer numstat's path list (authoritative) for risk.
    let riskAssessment = { risk, reasons: [] as string[] };
    // Authoritative changed paths from git — the merge gate's sensitive-path
    // forcing reads these, never the agent-declared Scope: trailer (which an
    // agent could under-report to dodge a code-review requirement).
    let changedPaths: string[] = scope;
    try {
      const stat = await git.numstat(namespace, repoName, defaultBranch, r.newSha);
      if (stat.paths.length) changedPaths = stat.paths;
      const priorRollbacks = (await db.select({ id: changes.id }).from(changes).where(and(
        eq(changes.repoId, repoId), eq(changes.openedByAgentId, agentId), eq(changes.status, "rolled_back"),
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

    // Serialize the branch + Change upsert per (repo, branch) so two concurrent
    // pushes to the same branch don't lose trailer metadata. The advisory lock
    // is released automatically at COMMIT/ROLLBACK.
    const upsertResult = await withChangeUpsertLock(db, repoId, branch, async tx => {
      await tx.insert(branches).values({ repoId, name: branch, headCommit: r.newSha })
        .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });

      const existingRows = await tx.select().from(changes).where(and(eq(changes.repoId, repoId), eq(changes.branch, branch))).limit(1);
      if (existingRows[0]) {
        await tx.update(changes).set({
          headCommit: r.newSha, intent, risk, computedRisk, riskReasons, scope, changedPaths, reviewFocus, trailers,
          hasConflicts, status: existingRows[0].isDraft ? "draft" : "pending", updatedAt: new Date(),
        }).where(eq(changes.id, existingRows[0].id));
        return { changeId: existingRows[0].id, isNew: false };
      }
      const ins = await tx.insert(changes).values({
        repoId, branch, headCommit: r.newSha, intent, risk, computedRisk, riskReasons,
        scope, changedPaths, reviewFocus, trailers, hasConflicts, openedByAgentId: agentId,
      }).returning();
      await tx.execute(sql`update agents set stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{changesOpened}', to_jsonb(coalesce((stats->>'changesOpened')::int, 0) + 1)) where id = ${agentId}`);
      return { changeId: ins[0].id, isNew: true };
    });
    const changeId = upsertResult.changeId;
    const existing = upsertResult.isNew ? [] : [{ id: changeId }];

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
    for (const p of pipelines) {
      const runnerToken = randomToken(18);
      const run = (await db.insert(ciRuns).values({ repoId, changeId, pipelineId: p.id, runnerToken, origin: "push", triggerDepth: 0, commit: r.newSha }).returning())[0];
      await events.publish({
        type: "ci.run.queued", repoId, changeId, actorKind: "agent", actorId: agentId,
        payload: { runId: run.id, repoNs: namespace, repoName, commit: r.newSha, pipelineYaml: p.yaml, runnerToken },
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
      repoId, changeId, actorKind: "agent", actorId: agentId,
      payload: { branch, intent, risk, hasConflicts, scope, reviewFocus },
    });

    // Run SAST + dep-scan + code index refresh asynchronously — never block the push.
    (async () => {
      try {
        const count = await sastScan(db, git, {
          namespace, repo: repoName, repoId, changeId,
          base: defaultBranch, head: r.newSha, scope,
        });
        if (count > 0) metrics.inc("clawhub_sast_findings_total", { repo: repoName }, count);
      } catch (e) { log("warn", "sast_scan_failed", { repoId, err: (e as Error).message }); }

      if (branch === defaultBranch) {
        try {
          const { findings } = await scanRepoHead(db, git, {
            namespace, repo: repoName, repoId, commit: r.newSha,
            openIssueCreator: { kind: "agent", id: agentId },
          });
          if (findings > 0) metrics.inc("clawhub_vuln_findings_total", { repo: repoName }, findings);
        } catch (e) { log("warn", "dep_scan_failed", { repoId, err: (e as Error).message }); }

        try {
          // Prior tip makes the reindex incremental: only files in the push.
          await indexRepoAtCommit(db, git, namespace, repoName, repoId, r.newSha, { sinceCommit: r.oldSha });
        } catch (e) { log("warn", "code_index_failed", { repoId, err: (e as Error).message }); }
      }
    })();
  }
}
