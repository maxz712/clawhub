import { execFile } from "node:child_process";
import path from "node:path";

function exec(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
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

export interface ReviewFocusArea {
  path: string;
  lines: string | null;
  description: string;
}

export interface ParsedMetadata {
  intent: string | null;
  risk: "low" | "medium" | "high" | "critical";
  scope: string[];
  decisions: string[];
  reviewFocus: ReviewFocusArea[];
  refs: string[];
  agentName: string | null;
  commitCount: number;
}

/**
 * Parse git trailers from commits on a branch that diverged from the default branch.
 * Uses `git log --format='%(trailers:key=...,valueonly)'` to extract structured metadata.
 */
export async function parseTrailersFromBranch(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<ParsedMetadata> {
  const absPath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(process.env.GIT_REPOS_BASE_PATH ?? "./data/repos", repoPath);

  // Count commits on this branch vs default
  let commitCount = 0;
  try {
    const { stdout: countOut } = await exec("git", [
      "-C", absPath,
      "rev-list", "--count",
      `${defaultBranch}..${branch}`,
    ]);
    commitCount = parseInt(countOut.trim(), 10) || 0;
  } catch {
    // Branch may not have diverged
  }

  if (commitCount === 0) {
    return {
      intent: null,
      risk: "medium",
      scope: [],
      decisions: [],
      reviewFocus: [],
      refs: [],
      agentName: null,
      commitCount: 0,
    };
  }

  // Get trailers from all commits on the branch
  let stdout = "";
  try {
    const result = await exec("git", [
      "-C", absPath,
      "log",
      `${defaultBranch}..${branch}`,
      "--format=%(trailers:key=Intent,valueonly)|||%(trailers:key=Risk,valueonly)|||%(trailers:key=Scope,valueonly)|||%(trailers:key=Refs,valueonly)|||%(trailers:key=Agent,valueonly)",
    ]);
    stdout = result.stdout;
  } catch {
    // Fall through to fallback
  }

  // Get Review-Focus trailers separately (can have multiples per commit)
  let focusRaw = "";
  try {
    const result = await exec("git", [
      "-C", absPath,
      "log",
      `${defaultBranch}..${branch}`,
      "--format=%(trailers:key=Review-Focus,valueonly)",
    ]);
    focusRaw = result.stdout;
  } catch {
    // Non-fatal
  }

  // Get Decisions trailers separately (can have multiples per commit)
  let decisionsRaw = "";
  try {
    const result = await exec("git", [
      "-C", absPath,
      "log",
      `${defaultBranch}..${branch}`,
      "--format=%(trailers:key=Decisions,valueonly)",
    ]);
    decisionsRaw = result.stdout;
  } catch {
    // Non-fatal
  }

  // Parse Review-Focus trailers
  const reviewFocus: ReviewFocusArea[] = focusRaw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      // Format: "src/api/profile.ts:47-52 — the new cache invalidation logic"
      const dashIndex =
        line.indexOf(" — ") !== -1
          ? line.indexOf(" — ")
          : line.indexOf(" - ");
      const pathPart =
        dashIndex > 0 ? line.slice(0, dashIndex).trim() : line.trim();
      const description =
        dashIndex > 0
          ? line.slice(dashIndex + (line.indexOf(" — ") !== -1 ? 3 : 3)).trim()
          : "";
      const colonIndex = pathPart.lastIndexOf(":");
      const hasLines =
        colonIndex > 0 && /^\d/.test(pathPart.slice(colonIndex + 1));
      return {
        path: hasLines ? pathPart.slice(0, colonIndex) : pathPart,
        lines: hasLines ? pathPart.slice(colonIndex + 1) : null,
        description,
      };
    });

  // Parse Decisions trailers
  const decisions: string[] = decisionsRaw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim());

  // Use the most recent commit's trailers (first line = most recent)
  const lines = stdout.trim().split("\n").filter(Boolean);
  const latest = lines[0];

  if (!latest || latest === "||||||||||||||||") {
    // No trailers — fall back to commit message as intent
    let msg = "";
    try {
      const result = await exec("git", [
        "-C", absPath,
        "log",
        `${defaultBranch}..${branch}`,
        "--format=%s",
        "-1",
      ]);
      msg = result.stdout.trim();
    } catch {
      // Non-fatal
    }

    return {
      intent: msg || null,
      risk: "medium",
      scope: [],
      decisions,
      reviewFocus,
      refs: [],
      agentName: null,
      commitCount,
    };
  }

  const [intent, risk, scope, refs, agent] = latest.split("|||");

  return {
    intent: intent?.trim() || null,
    risk: (["low", "medium", "high", "critical"] as const).includes(
      risk?.trim() as any
    )
      ? (risk.trim() as "low" | "medium" | "high" | "critical")
      : "medium",
    scope: scope?.trim()
      ? scope.split(",").map((s) => s.trim())
      : [],
    decisions,
    reviewFocus,
    refs: refs?.trim()
      ? refs.split(",").map((s) => s.trim())
      : [],
    agentName: agent?.trim() || null,
    commitCount,
  };
}
