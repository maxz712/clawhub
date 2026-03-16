import { eq, and, sql } from "drizzle-orm";
import { repositories, users, agents, auditEvents } from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";

interface Identity {
  id: string;
  type: "agent" | "user";
  ownerId?: string;
  canCreateRepos?: boolean;
  name?: string;
}

/**
 * Resolve an existing repo or auto-create one on push.
 *
 * Guardrails:
 * - Repos are created under the agent's owner account
 * - Per-account repo limit (max_repos) prevents runaway creation
 * - can_create_repos flag on Agent can be disabled by the owner
 * - All auto-creations are logged in the audit trail
 */
export async function resolveOrCreateRepo(
  db: Database,
  gitService: GitService,
  owner: string,
  repoName: string,
  identity: Identity
): Promise<{
  repo: typeof repositories.$inferSelect;
  user: typeof users.$inferSelect;
} | null> {
  // 1. Try to find existing repo by owner email prefix and repo name
  const allMatches = await db
    .select({
      repo: repositories,
      user: users,
    })
    .from(repositories)
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.name, repoName));

  let match = allMatches.find((row) => {
    const emailPrefix = row.user.email.split("@")[0];
    return emailPrefix === owner;
  });

  if (!match) {
    match = allMatches.find((row) => row.user.id === owner);
  }

  if (match) return match;

  // 2. Auto-create: find the user (owner)
  const allUsers = await db.select().from(users);
  const user =
    allUsers.find((u) => u.email.split("@")[0] === owner) ||
    allUsers.find((u) => u.id === owner);

  if (!user) return null;

  // 3. If identity is an agent, check constraints
  if (identity.type === "agent") {
    // Agent must belong to this owner
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, identity.id))
      .limit(1);

    if (!agent) return null;
    if (agent.ownerId !== user.id) return null;
    if (!agent.canCreateRepos) return null;
  }

  // 4. Check repo limit
  const repoCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.ownerId, user.id));
  const repoCount = Number(repoCountResult[0]?.count ?? 0);

  if (repoCount >= user.maxRepos) return null;

  // 5. Create the repo
  const gitPath = `${user.id}/${repoName}.git`;
  await gitService.initBareRepo(gitPath);

  const [repo] = await db
    .insert(repositories)
    .values({
      name: repoName,
      ownerId: user.id,
      createdBy: identity.type === "agent" ? identity.id : null,
      gitPath,
      defaultBranch: "main",
      isPublic: false,
    })
    .returning();

  // 6. Audit event
  await db.insert(auditEvents).values({
    repoId: repo.id,
    agentId: identity.type === "agent" ? identity.id : null,
    action: "repo_auto_created",
    metadata: {
      createdBy: identity.type,
      createdById: identity.id,
      owner,
      repoName,
    },
  });

  return { repo, user };
}
