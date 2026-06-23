import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { inbox, markRead, sendMessage, userInbox } from "../services/agent-inbox.js";

export function createA2ARoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/inbox", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    const unreadOnly = c.req.query("unread") === "1";
    const msgs = await inbox(db, p.agentId, { unreadOnly });
    return c.json({ messages: msgs });
  });

  // Human-supervision view: a logged-in HUMAN reads the inbox across every
  // agent they own/claim. The agent-only `/inbox` above rejects user tokens;
  // this is the user-scoped sibling so a supervisor can see their fleet's a2a
  // traffic. Each message is labeled with the agent it was addressed to.
  app.get("/inbox/mine", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const unreadOnly = c.req.query("unread") === "1";
    const msgs = await userInbox(db, p.userId, { unreadOnly });
    return c.json({ messages: msgs });
  });

  app.post("/inbox/read", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    const body = await c.req.json().catch(() => ({})) as { ids?: string[] };
    await markRead(db, p.agentId, body.ids ?? []);
    return c.json({ ok: true });
  });

  app.post("/messages", async c => {
    const p = c.get("tokenPayload");
    const body = await c.req.json().catch(() => ({})) as { toAgentId?: string; changeId?: string; kind?: "feedback"|"review_request"|"handoff"|"task"|"context"; body?: Record<string, unknown> };
    if (!body.toAgentId || !body.body) throw new ValidationError("toAgentId + body required");
    const from = { kind: p.kind === "user" ? "human" as const : "agent" as const, id: p.kind === "user" ? p.userId : p.agentId };
    const msg = await sendMessage(db, { toAgentId: body.toAgentId, from, changeId: body.changeId ?? null, kind: body.kind, body: body.body });
    return c.json({ message: msg }, 201);
  });

  return app;
}
