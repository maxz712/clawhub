import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, repositories } from "../models/schema.js";
import { RefLogService, verifyInternalSignature } from "../services/ref-log.js";
import { resolveNamespace } from "../services/repo-resolver.js";

/**
 * Internal endpoints for trusted shards (and tests). Authenticated via shared
 * HMAC: shards sign `{ts}.{sha256(body)}` with `CLAWHUB_INTERNAL_TOKEN` and
 * send `x-clawhub-ts` + `x-clawhub-sig` headers.
 *
 *   - `POST /api/v1/internal/ref-log` — Phase 4 WAL write. Called by the
 *     pre-receive hook on a shard BEFORE applying the ref locally. Body:
 *     `{namespace, repo, shardId, agentName?, updates: [{ref, oldSha, newSha}]}`.
 *     Returns 200 with the persisted entry IDs; the hook treats 4xx/5xx as a
 *     rejection and the push is aborted.
 */
const INTERNAL_TOKEN = process.env.CLAWHUB_INTERNAL_TOKEN ?? "";

export function createInternalRoutes(db: DB): Hono {
  const app = new Hono();
  const refSvc = new RefLogService(db);

  app.post("/ref-log", async c => {
    if (!INTERNAL_TOKEN) return c.json({ error: "internal_token_unset" }, 503);
    const raw = await c.req.text();
    const ts = c.req.header("x-clawhub-ts") ?? "";
    const sig = c.req.header("x-clawhub-sig") ?? "";
    if (!verifyInternalSignature(raw, INTERNAL_TOKEN, ts, sig)) {
      return c.json({ error: "bad_signature" }, 403);
    }

    let body: {
      namespace: string;
      repo: string;
      shardId: string;
      agentName?: string;
      updates: Array<{ ref: string; oldSha: string; newSha: string }>;
    };
    try { body = JSON.parse(raw); }
    catch { return c.json({ error: "invalid_json" }, 400); }
    if (!body.namespace || !body.repo || !body.shardId || !Array.isArray(body.updates)) {
      return c.json({ error: "missing_fields" }, 400);
    }

    const ns = await resolveNamespace(db, body.namespace);
    if (!ns) return c.json({ error: "namespace_not_found" }, 404);
    // SECURITY: scope the lookup to the resolved namespace — repositories.name is not
    // globally unique, so a name-only match could resolve to another tenant's repo.
    const repo = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, ns.kind),
      eq(repositories.namespaceId, ns.id),
      eq(repositories.name, body.repo),
    )).limit(1))[0];
    if (!repo) return c.json({ error: "repo_not_found" }, 404);

    let agentId: string | null = null;
    if (body.agentName) {
      const a = (await db.select().from(agents).where(eq(agents.name, body.agentName)).limit(1))[0];
      agentId = a?.id ?? null;
    }

    try {
      const rows = await refSvc.appendBatch(repo.id, body.updates.map(u => ({
        refName: u.ref,
        oldSha: u.oldSha,
        newSha: u.newSha,
        shardId: body.shardId,
        agentId,
      })));
      return c.json({ entries: rows.map(r => ({ id: r.id, ref: r.refName })) });
    } catch (e) {
      return c.json({ error: "wal_write_failed", message: (e as Error).message }, 500);
    }
  });

  return app;
}
