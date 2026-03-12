import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { agents, users } from "../models/schema.js";
import { generateToken } from "../services/auth.js";
import { ValidationError, NotFoundError } from "../services/errors.js";
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
