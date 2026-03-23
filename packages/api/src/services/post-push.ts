import { execFile } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { changes, auditEvents } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import type { ChangeRefService } from "./change-refs.js";
import { parseTrailersFromBranch } from "./trailer-parser.js";
import { parseReviewComments } from "./focus-parser.js";
import { identifyAuthor } from "./agent-identity.js";
import { assignReviewers, type ReviewerConfig } from "./reviewer-assignment.js";
import { evaluateEscalation, type EscalationRule } from "./escalation.js";
import { canMerge, type MergePolicy } from "./merge-policy.js";

function exec(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(
          Object.assign(error, {
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
          })
        );
      } else {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      }
    });
  });
}

interface RepoInfo {
  id: string;
  gitPath: string;
  defaultBranch: string;
  ownerId: string;
  mergePolicy: MergePolicy;
  reviewerConfig: ReviewerConfig;
  escalationPolicy: { rules: EscalationRule[] } | null;
}

interface PushIdentity {
  id: string;
  type: "agent" | "user";
}

/**
 * Process an incoming push by scanning branches for new changes.
 *
 * v2 agent-centric design:
 * - Uses authorId/authorType instead of agentId
 * - Trailer data is the source of truth (no heuristic risk fallback)
 * - After creating the Change record:
 *   1. Assigns reviewer agents via reviewer config
 *   2. Evaluates escalation policy
 *   3. Checks auto-merge rules
 *   4. Emits change.needs_review event
 */
export async function processIncomingPush(
  db: Database,
  gitService: GitService,
  eventBus: EventBus,
  changeRefService: ChangeRefService,
  repo: RepoInfo,
  pushIdentity?: PushIdentity
): Promise<void> {
  const repoPath = path.isAbsolute(repo.gitPath)
    ? repo.gitPath
    : path.resolve(
        process.env.GIT_REPOS_BASE_PATH ?? "./data/repos",
        repo.gitPath
      );

  // List all branches
  const { stdout: branchOutput } = await exec("git", [
    "-C",
    repoPath,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);

  const branches = branchOutput
    .trim()
    .split("\n")
    .filter((b) => b.length > 0);

  for (const branch of branches) {
    if (branch === repo.defaultBranch) continue;

    // Get diff between default branch and this branch
    let diff: string;
    try {
      diff = await gitService.getDiff(
        repo.gitPath,
        repo.defaultBranch,
        branch
      );
    } catch {
      continue;
    }

    if (!diff || diff.trim().length === 0) continue;

    // Parse git trailers from commits (source of truth for metadata)
    const metadata = await parseTrailersFromBranch(
      repoPath,
      branch,
      repo.defaultBranch
    );

    // Parse // REVIEW: inline comments from diff
    const reviewComments = await parseReviewComments(
      repoPath,
      branch,
      repo.defaultBranch
    );

    // Identify the author from trailers or git author
    const author = await identifyAuthor(
      db,
      repoPath,
      branch,
      repo.defaultBranch,
      metadata.agentName,
      pushIdentity?.id
    );

    // Determine authorId and authorType
    const authorId = author?.id ?? pushIdentity?.id;
    if (!authorId) continue; // Cannot create a change without an author

    const authorType: "agent" | "human" =
      author != null ? "agent" : (pushIdentity?.type === "user" ? "human" : "agent");

    // Derive scope from diff if not provided by trailers
    const scope =
      metadata.scope.length > 0
        ? metadata.scope
        : diff
            .split("\n")
            .filter((l) => l.startsWith("diff --git"))
            .map((l) => {
              const match = l.match(/b\/(.+)$/);
              return match ? match[1] : "";
            })
            .filter(Boolean);

    // Create Change record with trailer-sourced metadata
    const [change] = await db
      .insert(changes)
      .values({
        repoId: repo.id,
        authorId,
        authorType,
        branch,
        intent: metadata.intent || `Changes on branch ${branch}`,
        riskLevel: metadata.risk,
        scope,
        decisions: metadata.decisions,
        reviewFocus: metadata.reviewFocus,
        reviewComments,
        refs: metadata.refs,
        commitCount: metadata.commitCount,
        hasConflicts: false,
        status: "pending_review",
        escalated: false,
      })
      .returning();

    // Publish change refs and check for conflicts
    let hasConflicts = false;
    try {
      const result = await changeRefService.publishChangeRefs(
        repo.gitPath,
        change.id,
        branch,
        repo.defaultBranch
      );
      hasConflicts = result.hasConflicts;

      if (hasConflicts) {
        await db
          .update(changes)
          .set({ hasConflicts: true })
          .where(eq(changes.id, change.id));
      }
    } catch {
      // Non-fatal: change refs are supplementary
    }

    // Assign reviewer agents
    let assignedReviewers: string[] = [];
    try {
      assignedReviewers = await assignReviewers(
        db,
        repo.reviewerConfig,
        repo.ownerId,
        authorId
      );
    } catch {
      // Non-fatal: reviewer assignment failure should not block the push
    }

    // Evaluate escalation policy
    let escalated = false;
    let escalationReason: string | null = null;
    try {
      const escalationResult = evaluateEscalation(
        {
          riskLevel: metadata.risk,
          scope,
          commitCount: metadata.commitCount,
          hasConflicts,
        },
        null, // No review yet at push time
        repo.escalationPolicy
      );

      if (escalationResult?.escalate) {
        escalated = true;
        escalationReason = escalationResult.reason;
        await db
          .update(changes)
          .set({ escalated: true, escalationReason })
          .where(eq(changes.id, change.id));
      }
    } catch {
      // Non-fatal
    }

    // Check auto-merge rules
    let autoMerged = false;
    if (!escalated) {
      try {
        const mergeResult = canMerge(
          repo.mergePolicy,
          {
            riskLevel: metadata.risk,
            scope,
            authorId,
            escalated: false,
            commitCount: metadata.commitCount,
          },
          [] // No reviews yet
        );

        if (mergeResult.allowed) {
          // Auto-merge: update status to approved then merged
          await db
            .update(changes)
            .set({ status: "approved" })
            .where(eq(changes.id, change.id));
          autoMerged = true;
        }
      } catch {
        // Non-fatal
      }
    }

    // Audit event
    await db.insert(auditEvents).values({
      repoId: repo.id,
      actorId: authorId,
      actorType: authorType,
      action: "change_created",
      metadata: {
        changeId: change.id,
        intent: metadata.intent,
        riskLevel: metadata.risk,
        branch,
        scope,
        escalated,
        escalationReason,
        autoMerged,
        assignedReviewers,
        hasReviewFocus: metadata.reviewFocus.length > 0,
        hasReviewComments: reviewComments.length > 0,
      },
    });

    // Emit event
    await eventBus.emit({
      type: autoMerged ? "change.auto_merged" : "change.needs_review",
      repoId: repo.id,
      actorId: authorId,
      actorType: authorType,
      data: {
        changeId: change.id,
        intent: metadata.intent,
        riskLevel: metadata.risk,
        status: autoMerged ? "approved" : "pending_review",
        branch,
        scope,
        escalated,
        escalationReason,
        assignedReviewers,
        reviewFocusCount: metadata.reviewFocus.length,
        reviewCommentCount: reviewComments.length,
      },
      timestamp: new Date().toISOString(),
    });
  }
}
