import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { agents, users, auditEvents, permissionRules } from "../models/schema.js";
import { generateToken } from "../services/auth.js";
import { ValidationError, NotFoundError, AuthError } from "../services/errors.js";
import type { Database } from "../models/db.js";

export function createAgentRoutes(db: Database) {
  const app = new Hono();

  // POST /api/v1/agents — Register an agent
  app.post("/", async (c) => {
    const body = await c.req.json();
    const { name, type, owner_id, public_key, metadata } = body;

    if (!name || !owner_id) {
      throw new ValidationError("name and owner_id are required");
    }

    // Verify owner exists
    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.id, owner_id))
      .limit(1);

    if (!owner) {
      throw new NotFoundError("User", owner_id);
    }

    const validTypes = ["openclaw", "claude_code", "cursor", "generic"];
    const agentType = type && validTypes.includes(type) ? type : "generic";

    const [agent] = await db
      .insert(agents)
      .values({
        name,
        type: agentType,
        ownerId: owner_id,
        publicKey: public_key ?? null,
        metadata: metadata ?? null,
      })
      .returning();

    const token = generateToken(agent.id, "agent");

    return c.json(
      {
        agent: {
          id: agent.id,
          name: agent.name,
          type: agent.type,
          owner_id: agent.ownerId,
          created_at: agent.createdAt,
        },
        token,
      },
      201
    );
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

    const [owner] = await db
      .select()
      .from(users)
      .where(eq(users.id, agent.ownerId))
      .limit(1);

    if (!owner) {
      throw new NotFoundError("User", agent.ownerId);
    }

    return c.json({
      agent: {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        owner_id: agent.ownerId,
        public_key: agent.publicKey,
        metadata: agent.metadata,
        created_at: agent.createdAt,
      },
      owner: {
        id: owner.id,
        email: owner.email,
      },
    });
  });

  // GET /api/v1/agents/:id — Get agent info
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
        public_key: agent.publicKey,
        metadata: agent.metadata,
        created_at: agent.createdAt,
      },
    });
  });

  // GET /api/v1/agents/:id/activity — Get agent activity (audit events)
  app.get("/:id/activity", async (c) => {
    const agentId = c.req.param("id");

    // Verify agent exists
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
      .where(eq(auditEvents.agentId, agentId))
      .orderBy(auditEvents.timestamp);

    return c.json({
      activity: events.map((e) => ({
        id: e.id,
        repo_id: e.repoId,
        agent_id: e.agentId,
        action: e.action,
        metadata: e.metadata,
        timestamp: e.timestamp,
      })),
    });
  });

  // PUT /api/v1/agents/:id/permissions — Upsert permission rules for an agent
  app.put("/:id/permissions", async (c) => {
    const agentId = c.req.param("id");
    const payload = c.get("tokenPayload");
    const body = await c.req.json();

    if (payload.type !== "user") {
      throw new ValidationError("Only users can manage agent permissions");
    }

    const { repo_id, rules } = body;

    if (!repo_id || !rules || !Array.isArray(rules)) {
      throw new ValidationError("repo_id and rules array are required");
    }

    // Verify agent exists
    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      throw new NotFoundError("Agent", agentId);
    }

    // Verify requester owns the agent
    if (agent.ownerId !== payload.sub) {
      throw new AuthError("You do not own this agent");
    }

    const validTypes = ["allow_path", "deny_path", "require_approval", "auto_merge"];

    // Delete existing rules for this agent on this repo
    await db
      .delete(permissionRules)
      .where(
        eq(permissionRules.agentId, agentId)
      );

    // Insert new rules
    const insertedRules = [];
    for (const rule of rules) {
      const { rule_type, pattern, conditions } = rule;

      if (!rule_type || !pattern) {
        throw new ValidationError("Each rule must have rule_type and pattern");
      }

      if (!validTypes.includes(rule_type)) {
        throw new ValidationError(
          `Invalid rule_type. Must be one of: ${validTypes.join(", ")}`
        );
      }

      const [inserted] = await db
        .insert(permissionRules)
        .values({
          repoId: repo_id,
          agentId,
          ruleType: rule_type,
          pattern,
          conditions: conditions ?? null,
        })
        .returning();

      insertedRules.push(inserted);
    }

    await db.insert(auditEvents).values({
      repoId: repo_id,
      agentId,
      action: "agent_permissions_updated",
      metadata: { ruleCount: insertedRules.length },
    });

    return c.json({
      permission_rules: insertedRules.map((r) => ({
        id: r.id,
        repo_id: r.repoId,
        agent_id: r.agentId,
        rule_type: r.ruleType,
        pattern: r.pattern,
        conditions: r.conditions,
      })),
    });
  });

  return app;
}
