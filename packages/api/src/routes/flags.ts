import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { ValidationError } from "../services/errors.js";
import { deleteFlag, evaluate, listFlags, upsertFlag, type FlagRule } from "../services/feature-flags.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";

export function createFlagRoutes(db: DB): { publicEval: Hono; repo: Hono; global: Hono } {
  const publicEval = new Hono();
  // Evaluation can be called by anyone authed — agents check flags during their
  // execution, users may check in UIs.
  publicEval.use("*", authMiddleware);
  publicEval.post("/evaluate", async c => {
    const p = c.get("tokenPayload");
    const body = await c.req.json().catch(() => ({})) as { key?: string; repoId?: string; context?: { userId?: string; email?: string; agentId?: string } };
    if (!body.key) throw new ValidationError("key required");
    const context = body.context ?? (p.kind === "user" ? { userId: p.userId, email: p.email } : { agentId: p.agentId });
    const result = await evaluate(db, { key: body.key, repoId: body.repoId ?? null, context });
    return c.json(result);
  });

  const repo = new Hono();
  repo.use("*", authMiddleware);
  repo.get("/:ns/:repo/flags", async c => {
    const { repo: r } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    return c.json({ flags: await listFlags(db, r.id) });
  });
  repo.put("/:ns/:repo/flags/:key", async c => {
    const { repo: r } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { description?: string; enabled?: boolean; rolloutPercent?: number; rules?: FlagRule[] };
    const row = await upsertFlag(db, {
      repoId: r.id,
      key: c.req.param("key"),
      description: body.description,
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      rules: body.rules,
    });
    return c.json({ flag: row });
  });
  repo.delete("/:ns/:repo/flags/:id", async c => {
    // Authorize against the repo AND scope the delete to it — the id alone is a
    // global UUID, so an unscoped delete was a cross-repo IDOR (audit 2026-06-20).
    const { repo: r } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await deleteFlag(db, r.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  const global = new Hono();
  global.use("*", authMiddleware);
  global.get("/", async c => c.json({ flags: await listFlags(db, null) }));
  global.put("/:key", async c => {
    const body = await c.req.json().catch(() => ({})) as { description?: string; enabled?: boolean; rolloutPercent?: number; rules?: FlagRule[] };
    const row = await upsertFlag(db, {
      repoId: null,
      key: c.req.param("key"),
      description: body.description,
      enabled: body.enabled,
      rolloutPercent: body.rolloutPercent,
      rules: body.rules,
    });
    return c.json({ flag: row });
  });

  return { publicEval, repo, global };
}
