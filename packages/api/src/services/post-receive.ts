import { execFile } from "node:child_process";
import path from "node:path";
import { eq } from "drizzle-orm";
import { changes, auditEvents } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";
import type { IntentEngine } from "./intent.js";
import type { EventBus } from "./events.js";
import type { ChangeRefService } from "./change-refs.js";

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
}

interface AgentInfo {
  id: string;
}

/**
 * Parse conventional commit messages. Returns summary info if ALL commit
 * lines follow conventional commit format, otherwise returns null.
 */
export function parseConventionalCommits(
  commitLines: string[]
): { summary: string; details: string } | null {
  if (commitLines.length === 0) return null;

  // Pattern: <hash> <type>[(<scope>)][!]: <description>
  const conventionalPattern = /^[a-f0-9]+ (feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\(.+?\))?!?:\s+(.+)$/;

  const parsed: { type: string; description: string }[] = [];

  for (const line of commitLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(conventionalPattern);
    if (!match) return null;
    parsed.push({ type: match[1], description: match[3] });
  }

  if (parsed.length === 0) return null;

  // Build summary from the commit types
  const types = [...new Set(parsed.map((p) => p.type))];
  const summary = parsed.map((p) => p.description).join("; ");
  const details = `Conventional commits: ${types.join(", ")}`;

  return { summary, details };
}

/**
 * Process an incoming push by scanning branches for new changes.
 * Creates Change records for branches that have diverged from the default branch.
 */
export async function processIncomingPush(
  db: Database,
  gitService: GitService,
  intentEngine: IntentEngine,
  eventBus: EventBus,
  changeRefService: ChangeRefService,
  repo: RepoInfo,
  agent?: AgentInfo
): Promise<void> {
  const repoPath = path.isAbsolute(repo.gitPath)
    ? repo.gitPath
    : path.resolve(process.env.GIT_REPOS_BASE_PATH ?? "./data/repos", repo.gitPath);

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
      diff = await gitService.getDiff(repo.gitPath, repo.defaultBranch, branch);
    } catch {
      continue;
    }

    if (!diff || diff.trim().length === 0) continue;

    // Get recent commits
    let commitLines: string[] = [];
    try {
      const { stdout: logOutput } = await exec("git", [
        "-C",
        repoPath,
        "log",
        "--oneline",
        `${repo.defaultBranch}..${branch}`,
      ]);
      commitLines = logOutput
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    } catch {
      // No commits to parse
    }

    // Try conventional commits first
    const conventional = parseConventionalCommits(commitLines);

    let intent: string;
    let description: string | undefined;
    let riskLevel: "low" | "medium" | "high" | "critical" = "low";

    if (conventional) {
      intent = conventional.summary;
      description = conventional.details;
    } else {
      // Use intent engine
      const commitText = commitLines
        .map((l) => l.replace(/^[a-f0-9]+ /, ""))
        .join("\n");

      // Get file list from diff
      let fileList: string[] = [];
      try {
        fileList = await gitService.listFiles(repo.gitPath, branch);
      } catch {
        // Fallback: empty file list
      }

      const analysis = await intentEngine.analyzeChange({
        intent: commitText || `Changes on branch ${branch}`,
        description: `Branch ${branch} pushed with ${commitLines.length} commit(s)`,
        files: fileList.map((f) => ({ path: f, action: "modify" })),
      });

      intent = analysis.summary;
      description = analysis.architecturalImpact ?? undefined;
      riskLevel = analysis.riskLevel;
    }

    // Build diff summary
    const fileCount = diff.split("diff --git").length - 1;
    const diffSummary = {
      files_changed: fileCount > 0 ? fileCount : 1,
      source: "git_push",
    };

    // Create Change record
    const [change] = await db
      .insert(changes)
      .values({
        repoId: repo.id,
        agentId: agent?.id ?? null,
        intent,
        description: description ?? null,
        status: "pending",
        riskLevel,
        branch,
        source: "git_push",
        diffSummary,
        hasConflicts: false,
      })
      .returning();

    // Publish change refs and check for conflicts
    try {
      const { hasConflicts } = await changeRefService.publishChangeRefs(
        repo.gitPath,
        change.id,
        branch,
        repo.defaultBranch
      );

      if (hasConflicts) {
        await db
          .update(changes)
          .set({ hasConflicts: true })
          .where(eq(changes.id, change.id));
      }
    } catch {
      // Non-fatal: change refs are supplementary
    }

    // Audit event
    await db.insert(auditEvents).values({
      repoId: repo.id,
      agentId: agent?.id ?? null,
      action: "change_created",
      metadata: {
        changeId: change.id,
        intent,
        riskLevel,
        source: "git_push",
        branch,
      },
    });

    // Emit event
    await eventBus.emit({
      type: "change.created",
      repoId: repo.id,
      agentId: agent?.id,
      data: {
        changeId: change.id,
        intent,
        riskLevel,
        status: "pending",
        branch,
        source: "git_push",
      },
      timestamp: new Date().toISOString(),
    });
  }
}
