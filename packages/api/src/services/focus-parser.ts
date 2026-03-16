import { execFile } from "node:child_process";
import path from "node:path";

function exec(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
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

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Scan the diff between two branches for `// REVIEW:` inline comments.
 * Supports multiple comment syntaxes: //, #, --, /*, *
 */
export async function parseReviewComments(
  repoPath: string,
  branch: string,
  defaultBranch: string
): Promise<ReviewComment[]> {
  const absPath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(process.env.GIT_REPOS_BASE_PATH ?? "./data/repos", repoPath);

  let diff = "";
  try {
    const result = await exec("git", [
      "-C", absPath,
      "diff",
      `${defaultBranch}..${branch}`,
      "--unified=0",
    ]);
    diff = result.stdout;
  } catch {
    return [];
  }

  const comments: ReviewComment[] = [];
  let currentFile = "";
  let currentLine = 0;

  for (const line of diff.split("\n")) {
    // Track current file
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    }
    // Track line numbers from hunk headers
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)/);
      if (match) currentLine = parseInt(match[1], 10) - 1;
    }
    // Count added lines
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLine++;
      // Check for REVIEW: pattern (any comment syntax)
      const reviewMatch = line.match(
        /^\+\s*(?:\/\/|#|--|\/\*|\*)\s*REVIEW:\s*(.*)/
      );
      if (reviewMatch) {
        comments.push({
          path: currentFile,
          line: currentLine,
          body: reviewMatch[1].trim(),
        });
      }
    }
  }

  return comments;
}
