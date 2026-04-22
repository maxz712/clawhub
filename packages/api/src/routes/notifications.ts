import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { mentions } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError } from "../services/errors.js";
import { getPrefs, updatePrefs } from "../services/notifications.js";

export function createNotificationRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/prefs", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const prefs = await getPrefs(db, p.userId);
    return c.json({ prefs });
  });

  app.patch("/prefs", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const patch = await c.req.json().catch(() => ({}));
    const prefs = await updatePrefs(db, p.userId, patch);
    return c.json({ prefs });
  });

  app.get("/mentions", async c => {
    const p = c.get("tokenPayload");
    const kind = p.kind === "user" ? "human" : "agent";
    const id = p.kind === "user" ? p.userId : p.agentId;
    const rows = await db.select().from(mentions)
      .where(and(eq(mentions.mentionedKind, kind), eq(mentions.mentionedId, id)))
      .orderBy(desc(mentions.createdAt))
      .limit(100);
    return c.json({ mentions: rows });
  });

  app.post("/mentions/:id/ack", async c => {
    const p = c.get("tokenPayload");
    const kind = p.kind === "user" ? "human" : "agent";
    const id = p.kind === "user" ? p.userId : p.agentId;
    await db.update(mentions).set({ acknowledged: true })
      .where(and(eq(mentions.id, c.req.param("id")), eq(mentions.mentionedKind, kind), eq(mentions.mentionedId, id)));
    return c.json({ ok: true });
  });

  return app;
}
