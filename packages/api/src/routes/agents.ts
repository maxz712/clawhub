import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { agents, users, repositories, auditEvents } from "../models/schema.js";
import { generateToken } from "../services/auth.js";
import {
  ValidationError,
  NotFoundError,
  AuthError,
  ConflictError,
} from "../services/errors.js";
import type { Database } from "../models/db.js";

function generateClaimToken(): string {
  return randomBytes(32).toString("hex");
}

export function createAgentRoutes(db: Database) {
  const app = new Hono();

  // POST /api/v1/agents — Self-service agent registration (public, no user account needed)
  app.post("/", async (c) => {
    const body = await c.req.json();
    const { name, type, owner_id, can_review, git_author, metadata } = body;

    if (!name) {
      throw new ValidationError("name is required");
    }

    // Check if an agent with this name already exists
    const [existing] = await db
      .select()
      .from(agents)
      .where(eq(agents.name, name))
      .limit(1);

    if (existing) {
      throw new ConflictError("An agent with this name already exists");
    }

    const validTypes = ["openclaw", "claude_code", "cursor", "generic"];
    const agentType = type && validTypes.includes(type) ? type : "generic";

    // If owner_id is provided, verify the user exists and link immediately (no claim needed)
    let ownerId: string | null = null;
    let claimToken: string | null = null;

    if (owner_id) {
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, owner_id))
        .limit(1);

      if (!owner) {
        throw new NotFoundError("User", owner_id);
      }
      ownerId = owner_id;
    } else {
      // Self-service: generate a claim token so a human can claim this agent later
      claimToken = generateClaimToken();
    }

    const [agent] = await db
      .insert(agents)
      .values({
        name,
        type: agentType,
        ownerId,
        claimToken,
        canReview: can_review ?? true,
        gitAuthor: git_author ?? null,
        metadata: metadata ?? null,
      })
      .returning();

    const token = generateToken(agent.id, "agent");

    const response: Record<string, unknown> = {
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        owner_id: agent.ownerId,
        can_review: agent.canReview,
        git_author: agent.gitAuthor,
        max_repos: agent.maxRepos,
        created_at: agent.createdAt,
      },
      token,
    };

    // Only include claim_token if the agent is unclaimed
    if (claimToken) {
      response.claim_token = claimToken;
    }

    return c.json(response, 201);
  });

  return app;
}

export function createProtectedAgentRoutes(db: Database) {
  const app = new Hono();

  // GET /api/v1/agents/me — Get current agent + owner info
  app.get("/me", async (c) => {
    const payload = c.get("tokenPayload");
    if (payload.type !== "agent") {
      throw new AuthError("Not an agent token");
    }

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, payload.sub))
      .limit(1);

    if (!agent) {
      throw new NotFoundError("Agent", payload.sub);
    }

    const agentData: Record<string, unknown> = {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        owner_id: agent.ownerId,
        can_review: agent.canReview,
        git_author: agent.gitAuthor,
        max_repos: agent.maxRepos,
        review_stats: agent.reviewStats,
        metadata: agent.metadata,
        claimed: agent.ownerId !== null,
        created_at: agent.createdAt,
    };

    // Include claim_token if unclaimed so the agent can share it anytime
    if (!agent.ownerId && agent.claimToken) {
      agentData.claim_token = agent.claimToken;
    }

    const result: Record<string, unknown> = { agent: agentData };

    // Include owner info if claimed
    if (agent.ownerId) {
      const [owner] = await db
        .select()
        .from(users)
        .where(eq(users.id, agent.ownerId))
        .limit(1);

      if (owner) {
        result.owner = {
          id: owner.id,
          email: owner.email,
        };
      }
    }

    return c.json(result);
  });

  // POST /api/v1/agents/claim — Human claims an agent using the claim token
  app.post("/claim", async (c) => {
    const payload = c.get("tokenPayload");

    if (payload.type !== "user") {
      throw new AuthError("Only users can claim agents");
    }

    const body = await c.req.json();
    const { claim_token } = body;

    if (!claim_token) {
      throw new ValidationError("claim_token is required");
    }

    // Find agent by claim token
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.claimToken, claim_token))
      .limit(1);

    if (!agent) {
      throw new NotFoundError("Agent", "with this claim token");
    }

    if (agent.ownerId) {
      throw new ValidationError("This agent has already been claimed");
    }

    // Claim the agent — set owner, clear claim token
    const [updated] = await db
      .update(agents)
      .set({
        ownerId: payload.sub,
        claimToken: null,
      })
      .where(eq(agents.id, agent.id))
      .returning();

    // Transfer the agent's repos to the claiming user
    await db
      .update(repositories)
      .set({ ownerId: payload.sub })
      .where(eq(repositories.ownerAgentId, agent.id));

    // Audit event
    await db.insert(auditEvents).values({
      actorId: payload.sub,
      actorType: "human",
      action: "agent_claimed",
      metadata: {
        agentId: agent.id,
        agentName: agent.name,
      },
    });

    return c.json({
      agent: {
        id: updated.id,
        name: updated.name,
        type: updated.type,
        owner_id: updated.ownerId,
        can_review: updated.canReview,
        git_author: updated.gitAuthor,
        max_repos: updated.maxRepos,
        claimed: true,
        created_at: updated.createdAt,
      },
      message: "Agent successfully claimed.",
    });
  });

  // GET /api/v1/agents/:id — Get agent profile + review stats
  app.get("/:id", async (c) => {
    const agentId = c.req.param("id");

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      throw new NotFoundError("Agent", agentId);
    }

    return c.json({
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        owner_id: agent.ownerId,
        can_review: agent.canReview,
        git_author: agent.gitAuthor,
        max_repos: agent.maxRepos,
        review_stats: agent.reviewStats,
        metadata: agent.metadata,
        claimed: agent.ownerId !== null,
        created_at: agent.createdAt,
      },
    });
  });

  // GET /api/v1/agents/:id/activity — Get agent activity (audit events)
  app.get("/:id/activity", async (c) => {
    const agentId = c.req.param("id");

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      throw new NotFoundError("Agent", agentId);
    }

    const events = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.actorId, agentId))
      .orderBy(desc(auditEvents.timestamp));

    return c.json({
      activity: events.map((e) => ({
        id: e.id,
        repo_id: e.repoId,
        actor_id: e.actorId,
        actor_type: e.actorType,
        action: e.action,
        metadata: e.metadata,
        timestamp: e.timestamp,
      })),
    });
  });

  return app;
}
