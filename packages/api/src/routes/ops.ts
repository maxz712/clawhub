import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, killSwitches } from "../models/schema.js";
import type { ChangeService } from "../services/changes.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { blastRadius, disengage, engage } from "../services/kill-switch.js";

export function createOpsRoutes(db: DB, changeSvc: ChangeService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/agents/:id/kill-switch", async c => {
    const row = (await db.select().from(killSwitches).where(eq(killSwitches.agentId, c.req.param("id"))).limit(1))[0];
    return c.json({ engaged: !!row, row: row ?? null });
  });

  app.post("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { reason?: string };
    await engage(db, c.req.param("id"), body.reason ?? null, p.userId);
    return c.json({ ok: true });
  });

  app.delete("/agents/:id/kill-switch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await disengage(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/agents/:id/blast-radius", async c => {
    const hours = Number(c.req.query("hours") ?? 24);
    const report = await blastRadius(db, c.req.param("id"), hours);
    return c.json({ report });
  });

  app.post("/agents/:id/bulk-rollback", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { changeIds?: string[] };
    if (!Array.isArray(body.changeIds) || !body.changeIds.length) throw new ValidationError("changeIds required");
    const rows = await db.select().from(changes).where(and(eq(changes.openedByAgentId, c.req.param("id")), inArray(changes.id, body.changeIds)));
    const rolled: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const r of rows) {
      if (r.status !== "merged") { failed.push({ id: r.id, error: "not_merged" }); continue; }
      try { await changeSvc.rollback(r.id, { kind: "human", id: p.userId }); rolled.push(r.id); }
      catch (e) { failed.push({ id: r.id, error: (e as Error).message }); }
    }
    return c.json({ rolled, failed });
  });

  return app;
}
