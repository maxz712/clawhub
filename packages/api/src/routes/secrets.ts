import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { secrets } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { isSecretsKeyConfigured, seal } from "../services/secrets.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

export function createSecretRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/:ns/:repo/secrets", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(secrets).where(eq(secrets.repoId, repo.id));
    return c.json({ secrets: rows.map(r => ({ name: r.name, createdAt: r.createdAt })) });
  });

  app.put("/:ns/:repo/secrets/:name", async c => {
    if (!isSecretsKeyConfigured()) throw new ValidationError("server missing CLAWHUB_SECRETS_KEY");
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { value?: string };
    if (!body.value) throw new ValidationError("value required");
    const { ciphertext, nonce } = seal(body.value);
    const existing = (await db.select().from(secrets).where(and(eq(secrets.repoId, repo.id), eq(secrets.name, c.req.param("name")))).limit(1))[0];
    if (existing) {
      await db.update(secrets).set({ ciphertext, nonce }).where(eq(secrets.id, existing.id));
    } else {
      await db.insert(secrets).values({
        repoId: repo.id,
        name: c.req.param("name"),
        ciphertext,
        nonce,
        createdByUserId: p.kind === "user" ? p.userId : null,
      });
    }
    // Audit the NAME + actor only — NEVER the value (plaintext or ciphertext).
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId: p.kind === "user" ? p.userId : p.agentId,
      action: existing ? "secret.updated" : "secret.created",
      category: "secret",
      metadata: { name: c.req.param("name") },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  app.delete("/:ns/:repo/secrets/:name", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(secrets).where(and(eq(secrets.repoId, repo.id), eq(secrets.name, c.req.param("name")))).limit(1))[0];
    if (!row) throw new NotFoundError("secret");
    await db.delete(secrets).where(eq(secrets.id, row.id));
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "secret.deleted",
      category: "secret",
      metadata: { name: c.req.param("name") },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  return app;
}
