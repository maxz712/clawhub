import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents } from "../models/schema.js";
import { hashToken, randomToken, signToken } from "../services/auth.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";

export function createAgentRoutes(db: DB): Hono {
  const app = new Hono();

  // Public: self-register an agent.
  app.post("/", async c => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; gitAuthorName?: string; gitAuthorEmail?: string; capabilities?: { push?: boolean; review?: boolean } };
    if (!body.name) throw new ValidationError("name required");
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/i.test(body.name)) throw new ValidationError("bad name");
    const existing = await db.select().from(agents).where(eq(agents.name, body.name)).limit(1);
    if (existing[0]) throw new ConflictError("name taken");

    const claimToken = randomToken(18);
    const placeholder = await hashToken(randomToken(12));
    const inserted = await db.insert(agents).values({
      name: body.name,
      tokenHash: placeholder,
      claimToken,
      gitAuthorName: body.gitAuthorName ?? body.name,
      gitAuthorEmail: body.gitAuthorEmail ?? `${body.name}@agents.clawhub.dev`,
      capabilities: { push: body.capabilities?.push ?? true, review: body.capabilities?.review ?? false },
    }).returning();

    const agent = inserted[0];
    const token = signToken({ kind: "agent", agentId: agent.id, name: agent.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, agent.id));

    return c.json({
      agent: { id: agent.id, name: agent.name, capabilities: agent.capabilities },
      token,
      claim_token: claimToken,
    }, 201);
  });

  // Public: claim an agent by its claim_token — associate with current user.
  const protectedApp = new Hono();
  protectedApp.use("*", authMiddleware);

  protectedApp.post("/claim", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { claim_token?: string };
    if (!body.claim_token) throw new ValidationError("claim_token required");
    const row = (await db.select().from(agents).where(eq(agents.claimToken, body.claim_token)).limit(1))[0];
    if (!row) throw new NotFoundError("claim token");
    await db.update(agents).set({ associatedUserId: payload.userId, claimToken: null }).where(eq(agents.id, row.id));
    return c.json({ agent: { id: row.id, name: row.name } });
  });

  protectedApp.get("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const rows = await db.select().from(agents).where(eq(agents.associatedUserId, payload.userId));
    return c.json({ agents: rows.map(r => ({ id: r.id, name: r.name, gitAuthorName: r.gitAuthorName, gitAuthorEmail: r.gitAuthorEmail, capabilities: r.capabilities, stats: r.stats, createdAt: r.createdAt })) });
  });

  protectedApp.get("/me", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "agent") throw new AuthError("agent token required");
    const row = (await db.select().from(agents).where(eq(agents.id, payload.agentId)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    return c.json({ id: row.id, name: row.name, capabilities: row.capabilities, stats: row.stats, claim_token: row.claimToken });
  });

  protectedApp.post("/:id/rotate-token", async c => {
    const payload = c.get("tokenPayload");
    const id = c.req.param("id");
    const row = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
    if (!row) throw new NotFoundError("agent");
    if (payload.kind === "user" && row.associatedUserId !== payload.userId) throw new AuthError("not your agent");
    if (payload.kind === "agent" && row.id !== payload.agentId) throw new AuthError("not your agent");
    const token = signToken({ kind: "agent", agentId: row.id, name: row.name });
    await db.update(agents).set({ tokenHash: await hashToken(token) }).where(eq(agents.id, row.id));
    return c.json({ token });
  });

  app.route("/", protectedApp);
  return app;
}
