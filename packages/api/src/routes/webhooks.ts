import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { webhooks } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { randomToken } from "../services/auth.js";

export function createWebhookRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/webhooks", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(webhooks).where(eq(webhooks.repoId, repo.id));
    return c.json({ webhooks: rows.map(w => ({ ...w, secret: undefined })) });
  });

  app.post("/:ns/:repo/webhooks", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { url?: string; events?: string[]; enabled?: boolean };
    if (!body.url) throw new ValidationError("url required");
    const secret = randomToken(24);
    const inserted = (await db.insert(webhooks).values({
      repoId: repo.id, url: body.url, secret, events: body.events ?? [], enabled: body.enabled ?? true,
    }).returning())[0];
    return c.json({ webhook: { ...inserted, secret } }, 201);
  });

  app.delete("/:ns/:repo/webhooks/:id", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(webhooks).where(and(eq(webhooks.id, c.req.param("id")), eq(webhooks.repoId, repo.id))).limit(1))[0];
    if (!row) throw new NotFoundError("webhook");
    await db.delete(webhooks).where(eq(webhooks.id, row.id));
    return c.json({ ok: true });
  });

  return app;
}
