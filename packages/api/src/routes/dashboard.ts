import { Hono } from "hono";
import { eq, desc, inArray, sql, or } from "drizzle-orm";
import {
  repositories,
  agents,
  users,
  auditEvents,
  changes,
} from "../models/schema.js";
import type { Database } from "../models/db.js";

/**
 * Get all repo IDs visible to a user — repos they own directly
 * plus repos owned by their claimed agents.
 */
async function getUserRepos(db: Database, userId: string) {
  // Get agent IDs claimed by this user
  const claimedAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.ownerId, userId));
  const agentIds = claimedAgents.map((a) => a.id);

  // Get repos: owned by user directly OR owned by their claimed agents
  const conditions = [eq(repositories.ownerId, userId)];
  if (agentIds.length > 0) {
    conditions.push(inArray(repositories.ownerAgentId, agentIds));
  }

  return db
    .select()
    .from(repositories)
    .where(or(...conditions))
    .orderBy(desc(repositories.createdAt));
}

export function createDashboardRoutes(db: Database) {
  const app = new Hono();

  // GET /api/v1/dashboard/repos — List all repos visible to current user
  app.get("/repos", async (c) => {
    const payload = c.get("tokenPayload");

    const repos = await getUserRepos(db, payload.sub);

    const repoHealth = [];
    for (const repo of repos) {
      const repoChanges = await db
        .select()
        .from(changes)
        .where(eq(changes.repoId, repo.id));

      const escalatedCount = repoChanges.filter(
        (ch) => ch.escalated && ch.status !== "merged" && ch.status !== "rolled_back"
      ).length;
      const conflictCount = repoChanges.filter(
        (ch) => ch.hasConflicts && ch.status !== "merged" && ch.status !== "rolled_back"
      ).length;
      const pendingCount = repoChanges.filter(
        (ch) => ch.status === "pending_review"
      ).length;
      const mergedCount = repoChanges.filter(
        (ch) => ch.status === "merged"
      ).length;

      let health: "green" | "yellow" | "red" = "green";
      if (conflictCount > 0) health = "red";
      else if (escalatedCount > 0) health = "yellow";

      // Resolve owner display name (agent name or user email prefix)
      let ownerName = "";
      if (repo.ownerAgentId) {
        const [agent] = await db
          .select()
          .from(agents)
          .where(eq(agents.id, repo.ownerAgentId))
          .limit(1);
        if (agent) ownerName = agent.name;
      }
      if (!ownerName && repo.ownerId) {
        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.id, repo.ownerId))
          .limit(1);
        if (user) ownerName = user.email.split("@")[0];
      }

      repoHealth.push({
        id: repo.id,
        name: repo.name,
        owner: ownerName,
        owner_id: repo.ownerId,
        owner_agent_id: repo.ownerAgentId,
        description: repo.description,
        default_branch: repo.defaultBranch,
        health,
        escalated_count: escalatedCount,
        conflict_count: conflictCount,
        pending_count: pendingCount,
        merged_count: mergedCount,
        created_at: repo.createdAt,
      });
    }

    return c.json({ repositories: repoHealth });
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
        can_review: agent.canReview,
        review_stats: agent.reviewStats,
        metadata: agent.metadata,
        created_at: agent.createdAt,
      })),
    });
  });

  // GET /api/v1/dashboard/activity — Recent audit events for user's repos
  app.get("/activity", async (c) => {
    const payload = c.get("tokenPayload");

    const allRepos = await getUserRepos(db, payload.sub);
    const repoIds = allRepos.map((r) => r.id);

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
        actor_id: evt.actorId,
        actor_type: evt.actorType,
        action: evt.action,
        metadata: evt.metadata,
        timestamp: evt.timestamp,
      })),
    });
  });

  // GET /api/v1/dashboard/stats — Aggregate stats for current user
  app.get("/stats", async (c) => {
    const payload = c.get("tokenPayload");

    const allRepos = await getUserRepos(db, payload.sub);

    const [agentCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agents)
      .where(eq(agents.ownerId, payload.sub));

    const repoIds = allRepos.map((r) => r.id);

    let pendingCount = 0;
    let mergedCount = 0;
    let escalatedCount = 0;

    if (repoIds.length > 0) {
      const [pending] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .where(
          sql`${changes.repoId} IN ${repoIds} AND ${changes.status} = 'pending_review'`
        );
      pendingCount = pending?.count ?? 0;

      const [merged] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .where(
          sql`${changes.repoId} IN ${repoIds} AND ${changes.status} = 'merged'`
        );
      mergedCount = merged?.count ?? 0;

      const [escalated] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(changes)
        .where(
          sql`${changes.repoId} IN ${repoIds} AND ${changes.escalated} = true`
        );
      escalatedCount = escalated?.count ?? 0;
    }

    return c.json({
      stats: {
        total_repos: allRepos.length,
        total_agents: agentCount?.count ?? 0,
        pending_changes: pendingCount,
        merged_changes: mergedCount,
        escalated_changes: escalatedCount,
      },
    });
  });

  return app;
}
