import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { mentions } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError } from "../services/errors.js";
import {
  getPrefs, updatePrefs,
  listNotifications, unreadNotificationCount, markNotificationsRead, markAllNotificationsRead,
} from "../services/notifications.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNotificationRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Durable in-app inbox (humans only). The Bell feed of received notifications.
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const unread = c.req.query("unread") === "1" || c.req.query("unread") === "true";
    const rows = await listNotifications(db, p.userId, { unread });
    return c.json({ notifications: rows });
  });

  app.get("/unread-count", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const count = await unreadNotificationCount(db, p.userId);
    return c.json({ count });
  });

  app.post("/read", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown };
    // The ids come from untrusted JSON and go into `inArray(notifications.id, …)`
    // against a uuid column — a non-array body or a non-UUID element would make
    // Postgres throw (→ 500). Keep only UUID-shaped strings; garbage → no-op.
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : [];
    await markNotificationsRead(db, p.userId, ids);
    return c.json({ ok: true });
  });

  app.post("/read-all", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await markAllNotificationsRead(db, p.userId);
    return c.json({ ok: true });
  });

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
