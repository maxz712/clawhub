import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function execGit(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args);
    return stdout.trim();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args[0]} failed: ${message}`);
  }
}

export async function getRemoteUrl(remote = "origin"): Promise<string> {
  return execGit("remote", "get-url", remote);
}

export async function getCurrentBranch(): Promise<string> {
  return execGit("rev-parse", "--abbrev-ref", "HEAD");
}
