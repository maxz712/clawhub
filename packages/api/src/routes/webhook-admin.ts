import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { webhooks } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { listDeliveries, replayDelivery } from "../services/webhook-queue.js";
import { NotFoundError } from "../services/errors.js";

export function createWebhookAdminRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/webhooks/:id/deliveries", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const hook = (await db.select().from(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.repoId, repo.id))).limit(1))[0];
    if (!hook) throw new NotFoundError("webhook");
    const status = c.req.query("status") ?? undefined;
    const rows = await listDeliveries(db, hook.id, { status });
    return c.json({ deliveries: rows });
  });

  app.post("/:ns/:repo/webhooks/:id/deliveries/:deliveryId/replay", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const hook = (await db.select().from(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.repoId, repo.id))).limit(1))[0];
    if (!hook) throw new NotFoundError("webhook");
    await replayDelivery(db, c.req.param("deliveryId"));
    return c.json({ ok: true });
  });

  return app;
}
