import simpleGit, { SimpleGit } from "simple-git";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { GitError } from "./errors.js";

export interface FileChange {
  path: string;
  action: "create" | "modify" | "delete";
  content?: string;
  diff?: string;
  explanation?: string;
}

export interface GitServiceConfig {
  basePath: string;
}

export class GitService {
  private basePath: string;

  constructor(config: GitServiceConfig) {
    this.basePath = config.basePath;
  }

  private repoPath(gitPath: string): string {
    // If gitPath is absolute, use it directly; otherwise join with basePath
    if (path.isAbsolute(gitPath)) {
      return gitPath;
    }
    return path.join(this.basePath, gitPath);
  }

  private git(gitPath: string): SimpleGit {
    return simpleGit(this.repoPath(gitPath));
  }

  async initBareRepo(gitPath: string): Promise<string> {
    const fullPath = this.repoPath(gitPath);
    try {
      await mkdir(fullPath, { recursive: true });
      const git = simpleGit(fullPath);
      await git.init(true);
      // Create an initial commit on main so the branch exists
      // We need a temporary non-bare clone to create the initial commit
      const tmpPath = fullPath + "_tmp";
      await mkdir(tmpPath, { recursive: true });
      const tmpGit = simpleGit(tmpPath);
      await tmpGit.init();
      await tmpGit.addConfig("user.email", "system@clawforge.dev");
      await tmpGit.addConfig("user.name", "ClawForge System");
      // Create an initial empty commit
      await tmpGit.raw(["commit", "--allow-empty", "-m", "Initial commit"]);
      await tmpGit.raw(["remote", "add", "origin", fullPath]);
      await tmpGit.push("origin", "HEAD:refs/heads/main");
      // Cleanup tmp
      const { rm } = await import("node:fs/promises");
      await rm(tmpPath, { recursive: true, force: true });
      return fullPath;
    } catch (error) {
      throw new GitError(
        `Failed to init bare repo at ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async createBranch(
    gitPath: string,
    branchName: string,
    fromBranch: string = "main"
  ): Promise<void> {
    try {
      const repoDir = this.repoPath(gitPath);
      const git = simpleGit(repoDir);
      // For a bare repo, create a branch ref pointing to the same commit as fromBranch
      const commitHash = await git.revparse([fromBranch]);
      await git.raw([
        "update-ref",
        `refs/heads/${branchName}`,
        commitHash.trim(),
      ]);
    } catch (error) {
      throw new GitError(
        `Failed to create branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async applyDiff(
    gitPath: string,
    branchName: string,
    files: FileChange[],
    message: string = "Apply changes"
  ): Promise<string> {
    const repoDir = this.repoPath(gitPath);
    const tmpPath = repoDir + `_work_${Date.now()}`;

    try {
      await mkdir(tmpPath, { recursive: true });
      const tmpGit = simpleGit(tmpPath);

      // Clone from bare repo
      await tmpGit.clone(repoDir, tmpPath, ["--branch", branchName]);
      const workGit = simpleGit(tmpPath);
      await workGit.addConfig("user.email", "agent@clawforge.dev");
      await workGit.addConfig("user.name", "ClawForge Agent");

      const fs = await import("node:fs/promises");

      for (const file of files) {
        const filePath = path.join(tmpPath, file.path);
        const fileDir = path.dirname(filePath);
        await mkdir(fileDir, { recursive: true });

        if (file.action === "delete") {
          try {
            await fs.unlink(filePath);
          } catch {
            // File might not exist
          }
          await workGit.rm(file.path).catch(() => {});
        } else {
          // create or modify
          const content = file.content ?? "";
          await fs.writeFile(filePath, content, "utf-8");
          await workGit.add(file.path);
        }
      }

      await workGit.commit(message);
      await workGit.push("origin", branchName);

      const log = await workGit.log(["-1"]);
      const commitHash = log.latest?.hash ?? "";

      // Cleanup
      await fs.rm(tmpPath, { recursive: true, force: true });

      return commitHash;
    } catch (error) {
      // Cleanup on error
      const fs = await import("node:fs/promises");
      await fs.rm(tmpPath, { recursive: true, force: true }).catch(() => {});
      throw new GitError(
        `Failed to apply diff to branch '${branchName}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async mergeBranch(
    gitPath: string,
    sourceBranch: string,
    targetBranch: string = "main"
  ): Promise<string> {
    const repoDir = this.repoPath(gitPath);
    const tmpPath = repoDir + `_merge_${Date.now()}`;

    try {
      await mkdir(tmpPath, { recursive: true });
      const tmpGit = simpleGit(tmpPath);

      await tmpGit.clone(repoDir, tmpPath, ["--branch", targetBranch]);
      const workGit = simpleGit(tmpPath);
      await workGit.addConfig("user.email", "system@clawforge.dev");
      await workGit.addConfig("user.name", "ClawForge System");

      await workGit.fetch("origin", sourceBranch);
      await workGit.merge([`origin/${sourceBranch}`]);
      await workGit.push("origin", targetBranch);

      const log = await workGit.log(["-1"]);
      const commitHash = log.latest?.hash ?? "";

      const fs = await import("node:fs/promises");
      await fs.rm(tmpPath, { recursive: true, force: true });

      return commitHash;
    } catch (error) {
      const fs = await import("node:fs/promises");
      await fs.rm(tmpPath, { recursive: true, force: true }).catch(() => {});
      throw new GitError(
        `Failed to merge '${sourceBranch}' into '${targetBranch}': ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getDiff(
    gitPath: string,
    fromBranch: string,
    toBranch: string
  ): Promise<string> {
    try {
      const git = this.git(gitPath);
      const diff = await git.diff([`${fromBranch}..${toBranch}`]);
      return diff;
    } catch (error) {
      throw new GitError(
        `Failed to get diff: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listFiles(
    gitPath: string,
    branch: string = "main"
  ): Promise<string[]> {
    try {
      const git = this.git(gitPath);
      const result = await git.raw(["ls-tree", "-r", "--name-only", branch]);
      return result
        .trim()
        .split("\n")
        .filter((f) => f.length > 0);
    } catch (error) {
      throw new GitError(
        `Failed to list files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async getFileContents(
    gitPath: string,
    filePath: string,
    branch: string = "main"
  ): Promise<string> {
    try {
      const git = this.git(gitPath);
      const content = await git.show([`${branch}:${filePath}`]);
      return content;
    } catch (error) {
      throw new GitError(
        `Failed to get file contents: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async rollbackMerge(
    gitPath: string,
    branch: string = "main"
  ): Promise<string> {
    const repoDir = this.repoPath(gitPath);
    const tmpPath = repoDir + `_rollback_${Date.now()}`;

    try {
      await mkdir(tmpPath, { recursive: true });
      const tmpGit = simpleGit(tmpPath);

      await tmpGit.clone(repoDir, tmpPath, ["--branch", branch]);
      const workGit = simpleGit(tmpPath);
      await workGit.addConfig("user.email", "system@clawforge.dev");
      await workGit.addConfig("user.name", "ClawForge System");

      await workGit.revert("HEAD", ["--no-edit"]);
      await workGit.push("origin", branch);

      const log = await workGit.log(["-1"]);
      const commitHash = log.latest?.hash ?? "";

      const fs = await import("node:fs/promises");
      await fs.rm(tmpPath, { recursive: true, force: true });

      return commitHash;
    } catch (error) {
      const fs = await import("node:fs/promises");
      await fs.rm(tmpPath, { recursive: true, force: true }).catch(() => {});
      throw new GitError(
        `Failed to rollback: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
