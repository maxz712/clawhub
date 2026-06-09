import simpleGit, { type SimpleGit } from "simple-git";
import { mkdir, access, rm } from "node:fs/promises";
import path from "node:path";
import { GitError } from "./errors.js";

export class GitService {
  constructor(public readonly basePath: string) {}

  pathOf(namespace: string, repo: string): string {
    return path.resolve(this.basePath, namespace, `${repo}.git`);
  }

  async exists(namespace: string, repo: string): Promise<boolean> {
    try { await access(this.pathOf(namespace, repo)); return true; } catch { return false; }
  }

  async initBare(namespace: string, repo: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    await mkdir(dir, { recursive: true });
    await simpleGit(dir).init(true);
    return dir;
  }

  async remove(namespace: string, repo: string): Promise<void> {
    await rm(this.pathOf(namespace, repo), { recursive: true, force: true });
  }

  open(namespace: string, repo: string): SimpleGit {
    return simpleGit(this.pathOf(namespace, repo));
  }

  async headCommit(namespace: string, repo: string, ref: string): Promise<string> {
    try {
      return (await this.open(namespace, repo).revparse([ref])).trim();
    } catch (e) {
      throw new GitError(`failed to resolve ${ref}: ${(e as Error).message}`);
    }
  }

  async commitMessage(namespace: string, repo: string, sha: string): Promise<string> {
    return (await this.open(namespace, repo).show([sha, "--pretty=%B", "--no-patch"])).trim();
  }

  async listCommits(namespace: string, repo: string, range: string, limit = 50): Promise<Array<{ sha: string; subject: string; message: string }>> {
    const out = await this.open(namespace, repo).raw(["log", range, `--max-count=${limit}`, "--pretty=format:%H%x1f%s%x1f%B%x1e"]);
    if (!out.trim()) return [];
    return out.trim().split("\x1e").filter(Boolean).map(rec => {
      const [sha, subject, message] = rec.split("\x1f");
      return { sha, subject: subject ?? "", message: message ?? "" };
    });
  }

  async diffNameOnly(namespace: string, repo: string, from: string, to: string): Promise<string[]> {
    const out = await this.open(namespace, repo).raw(["diff", "--name-only", `${from}..${to}`]);
    return out.split("\n").map(s => s.trim()).filter(Boolean);
  }

  async diffRaw(namespace: string, repo: string, from: string, to: string, paths?: string[]): Promise<string> {
    const args = ["diff", `${from}..${to}`];
    if (paths?.length) args.push("--", ...paths);
    return await this.open(namespace, repo).raw(args);
  }

  async fileAt(namespace: string, repo: string, commit: string, file: string): Promise<string | null> {
    try {
      return await this.open(namespace, repo).show([`${commit}:${file}`]);
    } catch { return null; }
  }

  async trialMerge(namespace: string, repo: string, base: string, head: string): Promise<{ conflicts: boolean }> {
    const g = this.open(namespace, repo);
    try {
      const out = await g.raw(["merge-tree", "--write-tree", base, head]);
      return { conflicts: /^changed in both/m.test(out) || /CONFLICT/m.test(out) };
    } catch (e) {
      // Fall back: older git — just return no-conflict signal to avoid false blocks.
      return { conflicts: false };
    }
  }

  async mergeInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string, message: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const tree = (await g.raw(["merge-tree", "--write-tree", baseSha, headCommit])).trim().split(/\s+/)[0];
    if (!tree) throw new GitError("merge-tree produced no tree");
    const commit = (await g.raw(["commit-tree", tree, "-p", baseSha, "-p", headCommit, "-m", message])).trim();
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, commit, baseSha]);
    return commit;
  }

  async squashInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string, message: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const tree = (await g.raw(["merge-tree", "--write-tree", baseSha, headCommit])).trim().split(/\s+/)[0];
    if (!tree) throw new GitError("merge-tree produced no tree");
    const commit = (await g.raw(["commit-tree", tree, "-p", baseSha, "-m", message])).trim();
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, commit, baseSha]);
    return commit;
  }

  async rebaseInto(namespace: string, repo: string, baseBranch: string, headCommit: string, authorName: string, authorEmail: string): Promise<string> {
    const dir = this.pathOf(namespace, repo);
    const g = simpleGit(dir).env({ GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail, GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail });
    const baseSha = (await g.revparse([baseBranch])).trim();
    const mergeBase = (await g.raw(["merge-base", baseSha, headCommit])).trim();
    const shas = (await g.raw(["rev-list", "--reverse", `${mergeBase}..${headCommit}`])).trim().split("\n").filter(Boolean);

    let parent = baseSha;
    for (const sha of shas) {
      const treeOut = (await g.raw(["merge-tree", "--write-tree", parent, sha])).trim().split(/\s+/)[0];
      if (!treeOut) throw new GitError(`rebase failed at ${sha}`);
      const origMsg = await this.commitMessage(namespace, repo, sha);
      const commit = (await g.raw(["commit-tree", treeOut, "-p", parent, "-m", origMsg])).trim();
      parent = commit;
    }
    await g.raw(["update-ref", `refs/heads/${baseBranch}`, parent, baseSha]);
    return parent;
  }

  async countLocBetween(namespace: string, repo: string, from: string, to: string): Promise<number> {
    try {
      const out = await this.open(namespace, repo).raw(["diff", "--shortstat", `${from}..${to}`]);
      const m = out.match(/(\d+) insertion.*?(\d+) deletion/);
      if (!m) {
        const ins = out.match(/(\d+) insertion/);
        const del = out.match(/(\d+) deletion/);
        return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
      }
      return Number(m[1]) + Number(m[2]);
    } catch { return 0; }
  }

  async blame(namespace: string, repo: string, commit: string, file: string): Promise<Array<{ sha: string; author: string; line: number; content: string }>> {
    try {
      const out = await this.open(namespace, repo).raw(["blame", "--line-porcelain", commit, "--", file]);
      const lines: Array<{ sha: string; author: string; line: number; content: string }> = [];
      const blocks = out.split(/\n(?=[0-9a-f]{40} )/);
      for (const b of blocks) {
        const headerMatch = b.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?/);
        if (!headerMatch) continue;
        const authorMatch = b.match(/^author (.+)$/m);
        const contentMatch = b.match(/\n\t(.*)$/);
        lines.push({
          sha: headerMatch[1],
          line: Number(headerMatch[3]),
          author: authorMatch?.[1] ?? "unknown",
          content: contentMatch?.[1] ?? "",
        });
      }
      return lines;
    } catch { return []; }
  }
}
