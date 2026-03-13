import { Hono } from "hono";
import { eq, desc, inArray, sql } from "drizzle-orm";
import {
  repositories,
  agents,
  auditEvents,
  changes,
} from "../models/schema.js";
import type { Database } from "../models/db.js";

export function createDashboardRoutes(db: Database) {
  const app = new Hono();

  // GET /api/v1/dashboard/repos — List all repos owned by current user
  app.get("/repos", async (c) => {
    const payload = c.get("tokenPayload");

    const repos = await db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerId, payload.sub))
      .orderBy(desc(repositories.createdAt));

    return c.json({
      repositories: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        owner_id: repo.ownerId,
        git_path: repo.gitPath,
        description: repo.description,
        default_branch: repo.defaultBranch,
        created_at: repo.createdAt,
      })),
    });
  });

  // GET /api/v1/dashboard/agents — List all agents owned by current user
  app.get("/agents", async (c) => {
    const payload = c.get("tokenPayload");

    const userAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.ownerId, payload.sub))
      .orderBy(desc(agents.createdAt));

    return c.json({
      agents: userAgents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        owner_id: agent.ownerId,
        metadata: agent.metadata,
        created_at: agent.createdAt,
      })),
    });
  });

  // GET /api/v1/dashboard/activity — Recent audit events for user's repos
  app.get("/activity", async (c) => {
    const payload = c.get("tokenPayload");

    // Get the user's repo IDs
    const userRepos = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, payload.sub));

    const repoIds = userRepos.map((r) => r.id);

    if (repoIds.length === 0) {
      return c.json({ events: [] });
    }

    const events = await db
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.repoId, repoIds))
      .orderBy(desc(auditEvents.timestamp))
      .limit(50);

    return c.json({
      events: events.map((evt) => ({
        id: evt.id,
        repo_id: evt.repoId,
        agent_id: evt.agentId,
        action: evt.action,
        metadata: evt.metadata,
        timestamp: evt.timestamp,
      })),
    });
  });

  // GET /api/v1/dashboard/stats — Aggregate stats for current user
  app.get("/stats", async (c) => {
    const payload = c.get("tokenPayload");

    // Count repos
    const [repoCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(repositories)
      .where(eq(repositories.ownerId, payload.sub));

    // Count agents
    const [agentCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(eq(agents.ownerId, payload.sub));

    // Get user's repo IDs for change counts
    const userRepos = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.ownerId, payload.sub));

    const repoIds = userRepos.map((r) => r.id);

    let pendingCount = 0;
    let mergedCount = 0;

    if (repoIds.length > 0) {
      const [pending] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .where(
          sql`${changes.repoId} IN ${repoIds} AND ${changes.status} = 'pending'`
        );
      pendingCount = pending?.count ?? 0;

      const [merged] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .where(
          sql`${changes.repoId} IN ${repoIds} AND ${changes.status} = 'merged'`
        );
      mergedCount = merged?.count ?? 0;
    }

    return c.json({
      stats: {
        total_repos: repoCount?.count ?? 0,
        total_agents: agentCount?.count ?? 0,
        pending_changes: pendingCount,
        merged_changes: mergedCount,
      },
    });
  });

  return app;
}
