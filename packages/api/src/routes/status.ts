import { Hono } from "hono";
import { desc, eq, isNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { statusIncidents } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";

export function createStatusRoutes(db: DB): { pub: Hono; admin: Hono } {
  const pub = new Hono();
  pub.get("/", async c => {
    const active = await db.select().from(statusIncidents).where(isNull(statusIncidents.resolvedAt)).orderBy(desc(statusIncidents.startedAt));
    const recent = await db.select().from(statusIncidents).orderBy(desc(statusIncidents.startedAt)).limit(20);
    return c.json({
      overall: active.length === 0 ? "operational" : active[0].severity,
      active,
      recent,
    });
  });

  const admin = new Hono();
  admin.use("*", authMiddleware);

  admin.post("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { title?: string; body?: string; severity?: "minor"|"major"|"critical" };
    if (!body.title || !body.body) throw new ValidationError("title + body required");
    const [row] = await db.insert(statusIncidents).values({
      title: body.title,
      body: body.body,
      severity: body.severity ?? "minor",
    }).returning();
    return c.json({ incident: row }, 201);
  });

  admin.post("/:id/resolve", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await db.update(statusIncidents).set({ resolvedAt: new Date(), status: "resolved" }).where(eq(statusIncidents.id, c.req.param("id")));
    return c.json({ ok: true });
  });

  return { pub, admin };
}
