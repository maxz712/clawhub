import { eq, sql } from "drizzle-orm";
import {
  repositories,
  users,
  agents,
  auditEvents,
} from "../models/schema.js";
import type { Database } from "../models/db.js";
import type { GitService } from "./git.js";
import { DEFAULT_MERGE_POLICY } from "./merge-policy.js";
import { DEFAULT_REVIEWER_CONFIG } from "./reviewer-assignment.js";
import { DEFAULT_ESCALATION_RULES } from "./escalation.js";

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
 * Supports two ownership models:
 * 1. User-owned repos: agent pushes under a user's namespace (claimed agent)
 * 2. Agent-owned repos: unclaimed agent pushes under its own namespace
 *
 * Guardrails:
 * - Per-agent repo limit (max_repos) for agent-owned repos
 * - Per-user repo limit (max_repos) for user-owned repos
 * - can_create_repos flag on Agent can be disabled
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
  user: typeof users.$inferSelect | null;
} | null> {
  // 1. Try to find existing repo by owner and repo name
  //    Owner can be: user email prefix, user ID, agent name, or agent ID
  const allRepoMatches = await db
    .select({
      repo: repositories,
      user: users,
    })
    .from(repositories)
    .leftJoin(users, eq(repositories.ownerId, users.id))
    .where(eq(repositories.name, repoName));

  // Match by user email prefix or user ID
  let match = allRepoMatches.find((row) => {
    if (!row.user) return false;
    const emailPrefix = row.user.email.split("@")[0];
    return emailPrefix === owner;
  });

  if (!match) {
    match = allRepoMatches.find((row) => row.user && row.user.id === owner);
  }

  // Match by agent name or agent ID (for agent-owned repos)
  if (!match) {
    for (const row of allRepoMatches) {
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

  if (match) return { repo: match.repo, user: match.user };

  // 2. Auto-create: determine ownership model

  // Try user-owned first
  const allUsers = await db.select().from(users);
  const user =
    allUsers.find((u) => u.email.split("@")[0] === owner) ||
    allUsers.find((u) => u.id === owner);

  if (user) {
    return createUserOwnedRepo(db, gitService, user, repoName, identity);
  }

  // Try agent-owned (owner matches agent name or agent ID)
  if (identity.type === "agent") {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, identity.id))
      .limit(1);

    if (agent && (agent.name === owner || agent.id === owner)) {
      return createAgentOwnedRepo(db, gitService, agent, repoName, identity);
    }
  }

  return null;
}

async function createUserOwnedRepo(
  db: Database,
  gitService: GitService,
  user: typeof users.$inferSelect,
  repoName: string,
  identity: Identity
) {
  // If identity is an agent, check constraints
  let ownerAgentId: string | null = null;
  if (identity.type === "agent") {
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, identity.id))
      .limit(1);

    if (!agent) return null;
    if (agent.ownerId !== user.id) return null;
    if (!agent.canCreateRepos) return null;

    ownerAgentId = agent.id;
  }

  // Check user repo limit
  const repoCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.ownerId, user.id));
  const repoCount = Number(repoCountResult[0]?.count ?? 0);

  if (repoCount >= user.maxRepos) return null;

  // Build defaults, inheriting user's defaultEscalation if set
  const escalationPolicy = user.defaultEscalation
    ? (user.defaultEscalation as { rules: unknown[] })
    : { rules: DEFAULT_ESCALATION_RULES };

  const gitPath = `${user.id}/${repoName}.git`;
  await gitService.initBareRepo(gitPath);

  const [repo] = await db
    .insert(repositories)
    .values({
      name: repoName,
      ownerId: user.id,
      ownerAgentId,
      createdBy: identity.id,
      gitPath,
      defaultBranch: "main",
      isPublic: false,
      mergePolicy: DEFAULT_MERGE_POLICY,
      reviewerConfig: DEFAULT_REVIEWER_CONFIG,
      escalationPolicy,
    })
    .returning();

  await db.insert(auditEvents).values({
    repoId: repo.id,
    actorId: identity.id,
    actorType: identity.type === "agent" ? "agent" : "human",
    action: "repo_auto_created",
    metadata: { createdBy: identity.type, repoName, ownerAgentId },
  });

  return { repo, user };
}

async function createAgentOwnedRepo(
  db: Database,
  gitService: GitService,
  agent: typeof agents.$inferSelect,
  repoName: string,
  identity: Identity
) {
  if (!agent.canCreateRepos) return null;

  // Check agent repo limit
  const repoCountResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(repositories)
    .where(eq(repositories.ownerAgentId, agent.id));
  const repoCount = Number(repoCountResult[0]?.count ?? 0);

  if (repoCount >= agent.maxRepos) return null;

  const gitPath = `${agent.id}/${repoName}.git`;
  await gitService.initBareRepo(gitPath);

  const insertValues: Record<string, unknown> = {
      name: repoName,
      ownerAgentId: agent.id,
      createdBy: agent.id,
      gitPath,
      defaultBranch: "main",
      isPublic: false,
      mergePolicy: DEFAULT_MERGE_POLICY,
      reviewerConfig: DEFAULT_REVIEWER_CONFIG,
      escalationPolicy: { rules: DEFAULT_ESCALATION_RULES },
    };
  // Only set ownerId if the agent has a human owner — omit entirely when null
  // to avoid passing undefined/null to a column the postgres driver rejects
  if (agent.ownerId) {
    insertValues.ownerId = agent.ownerId;
  }

  const [repo] = await db
    .insert(repositories)
    .values(insertValues as typeof repositories.$inferInsert)
    .returning();

  await db.insert(auditEvents).values({
    repoId: repo.id,
    actorId: identity.id,
    actorType: "agent",
    action: "repo_auto_created",
    metadata: { createdBy: "agent", repoName, agentOwned: true },
  });

  return { repo, user: null };
}
