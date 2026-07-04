// GitHub App (N2) — mirror-and-verify state machine + check bridge.
//
// A pull_request on an installed GitHub repo is mirrored into a PRIVATE shadow
// ClawHub repo (owned by the `gh-mirror` service user), where the normal
// review/verify stack runs on it exactly like any ClawHub Change. When a verdict
// lands, `reportMirrorResult` posts it back to the GitHub PR as an advisory
// check-run + a comment. Nothing here needs the runner or harness to change —
// the whole Q3 review stack is reused; this file is only the bridge.
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, changes, githubPrMirrors, repositories, reviews, users, verificationRuns } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { ChangeRefService } from "./change-refs.js";
import type { EventBus } from "./events.js";
import { processPush } from "./post-push.js";
import { hashToken, randomToken } from "./auth.js";
import { assertPublicHttpHost } from "./url-guard.js";
import { log } from "./logger.js";
import {
  type GithubAppConfig, installationToken, getPullRequest,
  createCheckRun, updateCheckRun, createIssueComment,
} from "./github-app.js";

const MIRROR_NS = "gh-mirror";

/** Find-or-create the `gh-mirror` service user that owns every shadow repo. */
export async function ensureGhMirrorUser(db: DB): Promise<{ userId: string; username: string }> {
  const existing = (await db.select().from(users).where(eq(users.username, MIRROR_NS)).limit(1))[0];
  if (existing) {
    if (existing.kind !== "service") throw new Error(`cannot provision gh-mirror: username ${MIRROR_NS} is taken by a human`);
    return { userId: existing.id, username: MIRROR_NS };
  }
  const inserted = (await db.insert(users).values({
    email: `svc-gh-mirror@clawhub.invalid`,
    username: MIRROR_NS,
    name: "GitHub PR mirror",
    kind: "service",
    passwordHash: await hashToken(randomToken(24)),
  }).returning())[0];
  return { userId: inserted.id, username: MIRROR_NS };
}

function shadowRepoName(owner: string, repo: string): string {
  // `owner--repo`, sanitized to the same charset ClawHub repo names use.
  return `${owner}--${repo}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 100);
}

/** Ensure the private shadow repo (`gh-mirror/<owner>--<repo>`) + its bare git dir. */
async function ensureShadowRepo(db: DB, git: GitService, ownerUserId: string, owner: string, repo: string, defaultBranch: string): Promise<{ repoId: string; name: string }> {
  const name = shadowRepoName(owner, repo);
  const existing = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, "user"), eq(repositories.namespaceId, ownerUserId), eq(repositories.name, name),
  )).limit(1))[0];
  let repoId: string;
  if (existing) {
    repoId = existing.id;
    if (existing.defaultBranch !== defaultBranch) {
      await db.update(repositories).set({ defaultBranch }).where(eq(repositories.id, repoId));
    }
  } else {
    const inserted = (await db.insert(repositories).values({
      name,
      namespaceType: "user",
      namespaceId: ownerUserId,
      defaultBranch,
      description: `Shadow mirror of github.com/${owner}/${repo} (ClawHub review)`,
      isPublic: false, // shadow repos are always private
    }).returning())[0];
    repoId = inserted.id;
  }
  if (!(await git.exists(MIRROR_NS, name))) {
    await git.initBare(MIRROR_NS, name);
  }
  return { repoId, name };
}

export interface MirrorPullRequestInput {
  db: DB;
  git: GitService;
  changeRefs: ChangeRefService;
  events: EventBus;
  cfg: GithubAppConfig;
  installationId: string;
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Mirror (or re-sync) a PR into its shadow repo and open/refresh a ClawHub
 * Change. Idempotent on (owner, repo, prNumber): re-runs on `synchronize` update
 * the head + reopen the Change via the normal push path. Best-effort — records an
 * `error` state instead of throwing so the webhook always returns 200 fast.
 */
export async function mirrorPullRequest(input: MirrorPullRequestInput): Promise<{ ok: boolean; changeId?: string; error?: string }> {
  const { db, git, changeRefs, events, cfg, installationId, owner, repo, prNumber } = input;
  const upsertMirror = async (patch: Partial<typeof githubPrMirrors.$inferInsert>) => {
    const base = { installationId, owner, repo, prNumber, updatedAt: new Date() };
    await db.insert(githubPrMirrors).values({ headSha: "", ...base, ...patch })
      .onConflictDoUpdate({ target: [githubPrMirrors.owner, githubPrMirrors.repo, githubPrMirrors.prNumber], set: { ...base, ...patch } });
  };
  try {
    const token = await installationToken(cfg, installationId);
    const pr = await getPullRequest(token, owner, repo, prNumber);
    if (!pr) { await upsertMirror({ state: "error", lastError: "PR not found" }); return { ok: false, error: "pr_not_found" }; }
    const baseRef = pr.base.ref;
    const cloneUrl = pr.head.repo?.clone_url ?? `https://github.com/${owner}/${repo}.git`;
    const blocked = await assertPublicHttpHost(cloneUrl);
    if (blocked) { await upsertMirror({ state: "error", lastError: `clone url rejected: ${blocked}` }); return { ok: false, error: "clone_rejected" }; }

    const { userId } = await ensureGhMirrorUser(db);
    const shadow = await ensureShadowRepo(db, git, userId, owner, repo, baseRef);

    // Fetch the PR base + head from GitHub into the bare shadow repo. Use the
    // always-advertised `refs/pull/<n>/head` (fetching a bare SHA can be rejected).
    const authUrl = cloneUrl.replace("https://", `https://x-access-token:${token}@`);
    const g = git.open(MIRROR_NS, shadow.name);
    const branchName = `pr-${prNumber}`;
    // Base first (so the diff/trial-merge target exists), then the PR head.
    await g.raw(["fetch", "--no-tags", authUrl, `refs/heads/${baseRef}:refs/heads/${baseRef}`]).catch(() => {});
    const prevSha = await g.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]).then(s => s.trim()).catch(() => "");
    await g.raw(["fetch", "--no-tags", "--force", authUrl, `refs/pull/${prNumber}/head:refs/heads/${branchName}`]);
    const headSha = (await g.raw(["rev-parse", `refs/heads/${branchName}`])).trim();

    // Open/refresh the Change via the normal post-push pipeline.
    await processPush({
      db, git, changeRefs, events,
      namespace: MIRROR_NS, repoName: shadow.name, repoId: shadow.repoId,
      defaultBranch: baseRef,
      actor: { kind: "user", userId },
      pushedRefs: [{ ref: `refs/heads/${branchName}`, oldSha: prevSha || "0".repeat(40), newSha: headSha }],
    });

    const change = (await db.select({ id: changes.id }).from(changes)
      .where(and(eq(changes.repoId, shadow.repoId), eq(changes.branch, branchName))).limit(1))[0];
    await upsertMirror({
      headSha, headRef: pr.head.ref, baseRef, cloneUrl,
      mirrorRepoId: shadow.repoId, changeId: change?.id ?? null, state: "mirrored", lastError: null,
    });

    // Announce we're reviewing (advisory check-run, in_progress).
    const detailsUrl = change ? `${(process.env.CLAWHUB_DASHBOARD_URL ?? "https://useclawhub.com").replace(/\/+$/, "")}/repos/${MIRROR_NS}/${shadow.name}/changes/${change.id}` : undefined;
    const checkRunId = await createCheckRun(token, owner, repo, {
      headSha, status: "in_progress",
      title: "ClawHub review in progress",
      summary: "ClawHub mirrored this PR and is running its review/verify agents. A verdict will be posted here.",
      detailsUrl,
    }).catch(() => null);
    if (checkRunId) await db.update(githubPrMirrors).set({ checkRunId, state: "reviewing", updatedAt: new Date() })
      .where(and(eq(githubPrMirrors.owner, owner), eq(githubPrMirrors.repo, repo), eq(githubPrMirrors.prNumber, prNumber)));

    // Make the base branch visible in the shadow repo's branch list (cosmetic).
    await db.insert(branches).values({ repoId: shadow.repoId, name: baseRef, headCommit: headSha })
      .onConflictDoNothing().catch(() => {});

    log("info", "github_pr_mirrored", { owner, repo, prNumber, changeId: change?.id, headSha });
    return { ok: true, changeId: change?.id };
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 500) ?? "mirror failed";
    await upsertMirror({ state: "error", lastError: msg }).catch(() => {});
    log("warn", "github_pr_mirror_failed", { owner, repo, prNumber, error: msg });
    return { ok: false, error: msg };
  }
}

export interface ReportInput {
  conclusion: "success" | "neutral" | "failure";
  title: string;
  summary: string;
  comment?: string;
}

/**
 * Post a ClawHub verdict back to the GitHub PR: update the advisory check-run to
 * a terminal conclusion, and (once) drop a summary comment. Never blocks the PR —
 * the check is advisory (conclusion `neutral` even on request-changes in MVP,
 * caller decides). Idempotent-ish: guarded by the mirror row's `reportedAt`.
 */
export async function reportMirrorResult(db: DB, cfg: GithubAppConfig, mirror: typeof githubPrMirrors.$inferSelect, report: ReportInput, opts: { comment?: boolean } = {}): Promise<boolean> {
  try {
    const token = await installationToken(cfg, mirror.installationId);
    const detailsUrl = mirror.mirrorRepoId && mirror.changeId
      ? `${(process.env.CLAWHUB_DASHBOARD_URL ?? "https://useclawhub.com").replace(/\/+$/, "")}/repos/${MIRROR_NS}/${shadowRepoName(mirror.owner, mirror.repo)}/changes/${mirror.changeId}`
      : undefined;
    if (mirror.checkRunId) {
      await updateCheckRun(token, mirror.owner, mirror.repo, mirror.checkRunId, {
        status: "completed", conclusion: report.conclusion, title: report.title, summary: report.summary, detailsUrl,
      });
    } else {
      const id = await createCheckRun(token, mirror.owner, mirror.repo, {
        headSha: mirror.headSha, status: "completed", conclusion: report.conclusion, title: report.title, summary: report.summary, detailsUrl,
      });
      if (id) await db.update(githubPrMirrors).set({ checkRunId: id }).where(eq(githubPrMirrors.id, mirror.id));
    }
    if (opts.comment && report.comment && !mirror.reportedAt) {
      await createIssueComment(token, mirror.owner, mirror.repo, mirror.prNumber, report.comment);
    }
    await db.update(githubPrMirrors).set({ state: "reported", reportedAt: new Date(), updatedAt: new Date() }).where(eq(githubPrMirrors.id, mirror.id));
    return true;
  } catch (e) {
    log("warn", "github_report_failed", { id: mirror.id, error: (e as Error).message });
    return false;
  }
}

/** Look up the mirror row backing a ClawHub change (for the event-driven bridge). */
export async function mirrorForChange(db: DB, changeId: string): Promise<typeof githubPrMirrors.$inferSelect | null> {
  return (await db.select().from(githubPrMirrors).where(eq(githubPrMirrors.changeId, changeId)).limit(1))[0] ?? null;
}

/**
 * Event-driven check bridge: when a review/verify verdict lands on a mirrored
 * Change, post it back to the GitHub PR. Advisory in MVP — the check is NEVER a
 * blocking `failure` (agents inform; the GitHub-side human still decides), so a
 * request-changes verdict lands as `neutral` with the concerns spelled out.
 * Called best-effort from the app-level event subscription.
 */
export async function bridgeChangeEvent(db: DB, cfg: GithubAppConfig, changeId: string): Promise<void> {
  const mirror = await mirrorForChange(db, changeId);
  if (!mirror) return; // not a GitHub-mirrored change — nothing to report
  const change = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
  if (!change) return;

  // Latest verification for the current head + latest advisory review.
  const verification = (await db.select().from(verificationRuns)
    .where(and(eq(verificationRuns.changeId, changeId), eq(verificationRuns.headCommit, change.headCommit)))
    .orderBy(desc(verificationRuns.createdAt)).limit(1))[0];
  const review = (await db.select().from(reviews)
    .where(and(eq(reviews.changeId, changeId), eq(reviews.advisory, true), isNull(reviews.supersededAt)))
    .orderBy(desc(reviews.submittedAt)).limit(1))[0];

  let conclusion: "success" | "neutral" | "failure" = "neutral";
  let title = "ClawHub review";
  const lines: string[] = [];

  if (verification) {
    const ok = verification.status === "success";
    conclusion = ok ? "success" : "neutral";
    title = ok ? "ClawHub verified ✓" : "ClawHub verification incomplete";
    const checks = Array.isArray(verification.checks) ? verification.checks as Array<{ name?: string; kind?: string; ok?: boolean }> : [];
    if (checks.length) lines.push(...checks.map(ck => `${ck.ok ? "✓" : "✗"} ${ck.name ?? ck.kind ?? "check"}`));
    if (verification.tier) lines.push(`_tier: ${verification.tier}_`);
  }
  if (review) {
    const contract = (review.contract ?? {}) as { verdict?: string; intent_vs_diff?: string };
    const verdict = contract.verdict ?? review.verdict;
    if (!verification) {
      conclusion = "neutral"; // advisory review is never blocking
      title = verdict === "approve" ? "ClawHub review: looks good"
        : verdict === "request_changes" ? "ClawHub review: concerns flagged"
        : "ClawHub review";
    }
    const note = contract.intent_vs_diff ?? review.summary;
    if (note) lines.push(String(note).slice(0, 1000));
  }
  if (!verification && !review) return; // nothing conclusive yet

  const dash = (process.env.CLAWHUB_DASHBOARD_URL ?? "https://useclawhub.com").replace(/\/+$/, "");
  const changeUrl = `${dash}/repos/${MIRROR_NS}/${shadowRepoName(mirror.owner, mirror.repo)}/changes/${changeId}`;
  const summary = (lines.length ? lines.join("\n") : "ClawHub ran its review/verify agents on this PR.")
    + `\n\n[View the full review on ClawHub →](${changeUrl})`;
  const comment = `### ${title}\n\n${summary}\n\n<sub>Advisory — ClawHub mirrored this PR and reviewed it. This check never blocks your merge.</sub>`;

  await reportMirrorResult(db, cfg, mirror, { conclusion, title, summary, comment }, { comment: true });
}
