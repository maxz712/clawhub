import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitService } from "./git.js";

const pexec = promisify(execFile);

export class ChangeRefService {
  constructor(private readonly git: GitService) {}

  async set(namespace: string, repo: string, changeId: string, commit: string): Promise<void> {
    const dir = this.git.pathOf(namespace, repo);
    await pexec("git", ["-C", dir, "update-ref", `refs/changes/${changeId}`, commit]);
  }

  async delete(namespace: string, repo: string, changeId: string): Promise<void> {
    const dir = this.git.pathOf(namespace, repo);
    try { await pexec("git", ["-C", dir, "update-ref", "-d", `refs/changes/${changeId}`]); } catch {}
  }

  async resolve(namespace: string, repo: string, changeId: string): Promise<string | null> {
    const dir = this.git.pathOf(namespace, repo);
    try {
      const { stdout } = await pexec("git", ["-C", dir, "rev-parse", `refs/changes/${changeId}`]);
      return stdout.trim();
    } catch { return null; }
  }
}
