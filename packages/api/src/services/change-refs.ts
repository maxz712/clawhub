import { execFile } from "node:child_process";
import path from "node:path";

function exec(
  command: string,
  args: string[],
  options?: { env?: Record<string, string | undefined> }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: { ...process.env, ...options?.env } },
      (error, stdout, stderr) => {
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
      }
    );
  });
}

export class ChangeRefService {
  constructor(private basePath: string) {}

  private resolvePath(repoGitPath: string): string {
    if (path.isAbsolute(repoGitPath)) {
      return repoGitPath;
    }
    return path.resolve(this.basePath, repoGitPath);
  }

  /**
   * Publish change refs for a change:
   * - refs/changes/<changeId>/head → points to the branch tip
   * - refs/changes/<changeId>/merge → trial merge commit (if no conflicts)
   */
  async publishChangeRefs(
    repoGitPath: string,
    changeId: string,
    branch: string,
    defaultBranch: string
  ): Promise<{ hasConflicts: boolean }> {
    const repoPath = this.resolvePath(repoGitPath);

    // Get the commit hash for the branch
    const { stdout: branchRef } = await exec("git", [
      "-C",
      repoPath,
      "rev-parse",
      `refs/heads/${branch}`,
    ]);
    const branchCommit = branchRef.trim();

    // Create refs/changes/<changeId>/head pointing to the branch tip
    await exec("git", [
      "-C",
      repoPath,
      "update-ref",
      `refs/changes/${changeId}/head`,
      branchCommit,
    ]);

    // Attempt trial merge using merge-tree
    try {
      const { stdout: mergeTreeOutput } = await exec("git", [
        "-C",
        repoPath,
        "merge-tree",
        "--write-tree",
        `refs/heads/${defaultBranch}`,
        `refs/heads/${branch}`,
      ]);

      const treeHash = mergeTreeOutput.trim().split("\n")[0];

      // Get parent commits
      const { stdout: defaultRef } = await exec("git", [
        "-C",
        repoPath,
        "rev-parse",
        `refs/heads/${defaultBranch}`,
      ]);
      const defaultCommit = defaultRef.trim();

      // Create a merge commit with commit-tree
      const gitEnv = {
        GIT_AUTHOR_NAME: "ClawForge System",
        GIT_AUTHOR_EMAIL: "system@clawforge.dev",
        GIT_COMMITTER_NAME: "ClawForge System",
        GIT_COMMITTER_EMAIL: "system@clawforge.dev",
      };

      const { stdout: commitHash } = await exec(
        "git",
        [
          "-C",
          repoPath,
          "commit-tree",
          treeHash,
          "-p",
          defaultCommit,
          "-p",
          branchCommit,
          "-m",
          `Trial merge for change ${changeId}`,
        ],
        { env: gitEnv }
      );

      // Update the merge ref
      await exec("git", [
        "-C",
        repoPath,
        "update-ref",
        `refs/changes/${changeId}/merge`,
        commitHash.trim(),
      ]);

      return { hasConflicts: false };
    } catch {
      // merge-tree failed — conflicts detected
      return { hasConflicts: true };
    }
  }

  /**
   * Clean up change refs after merge/reject.
   */
  async cleanupChangeRefs(
    repoGitPath: string,
    changeId: string
  ): Promise<void> {
    const repoPath = this.resolvePath(repoGitPath);

    for (const refSuffix of ["head", "merge"]) {
      try {
        await exec("git", [
          "-C",
          repoPath,
          "update-ref",
          "-d",
          `refs/changes/${changeId}/${refSuffix}`,
        ]);
      } catch {
        // Ref may not exist, that's fine
      }
    }
  }
}
