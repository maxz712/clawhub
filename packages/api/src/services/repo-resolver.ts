import { eq } from "drizzle-orm";
import { repositories, users, agents } from "../models/schema.js";
import type { Database } from "../models/db.js";

/**
 * Resolve a repository by owner identifier and repo name.
 *
 * Owner can be:
 * - User email prefix (e.g. "alice" for alice@example.com)
 * - User ID (UUID)
 * - Agent name (for agent-owned repos)
 * - Agent ID (UUID, for agent-owned repos)
 */
export async function resolveRepoByOwnerAndName(
  db: Database,
  owner: string,
  repoName: string
): Promise<{
  repo: typeof repositories.$inferSelect;
  user: (typeof users.$inferSelect) | null;
} | null> {
  const results = await db
    .select({ repo: repositories, user: users })
    .from(repositories)
    .leftJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.name, repoName));

  // Match by user email prefix or user ID
  let match =
    results.find((r) => r.user && r.user.email.split("@")[0] === owner) ||
    results.find((r) => r.user && r.user.id === owner) ||
    null;

  // Match by agent name or agent ID (for agent-owned repos)
  if (!match) {
    for (const row of results) {
      if (!row.repo.ownerAgentId) continue;
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, row.repo.ownerAgentId))
        .limit(1);
      if (agent && (agent.name === owner || agent.id === owner)) {
        match = row;
        break;
      }
    }
  }

  return match;
}
