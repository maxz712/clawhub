import { execFile } from "node:child_process";
import { eq } from "drizzle-orm";
import path from "node:path";
import { agents } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { Agent } from "../models/schema.js";

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

/**
 * Identify the agent that authored commits on a branch.
 * Returns the Agent record if found, or null.
 *
 * Priority:
 * 1. Agent: trailer in commit → look up agent by name
 * 2. Git author email → look up agent by gitAuthor
 * 3. Fall back to the identity that authenticated the push
 */
export async function identifyAuthor(
  db: Database,
  repoPath: string,
  branch: string,
  defaultBranch: string,
  agentNameFromTrailer: string | null,
  pusherId?: string
): Promise<Agent | null> {
  const absPath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(process.env.GIT_REPOS_BASE_PATH ?? "./data/repos", repoPath);

  // 1. Check Agent: trailer
  if (agentNameFromTrailer) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.name, agentNameFromTrailer))
      .limit(1);
    if (agent) return agent;
  }

  // 2. Check git author email
  try {
    const { stdout: authorEmail } = await exec("git", [
      "-C", absPath,
      "log",
      `${defaultBranch}..${branch}`,
      "--format=%ae",
      "-1",
    ]);
    const email = authorEmail.trim();
    if (email) {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.gitAuthor, email))
        .limit(1);
      if (agent) return agent;
    }
  } catch {
    // Non-fatal
  }

  // 3. Fall back to the identity that authenticated the push
  if (pusherId) {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, pusherId))
      .limit(1);
    if (agent) return agent;
  }

  return null;
}
