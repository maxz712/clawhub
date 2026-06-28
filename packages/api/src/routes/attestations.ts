import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { attestations, changes, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { isPlatformAdminEmail } from "./admin.js";
import { requireRepoRead } from "../services/repo-access.js";
import { createAttestation, listByChange, listByCommit, rotateSigningKey, verifyAttestation } from "../services/provenance.js";

export function createAttestationRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    const body = await c.req.json().catch(() => ({})) as {
      repoId?: string; changeId?: string; commitSha?: string;
      agentVersion?: string; modelName?: string; modelVersion?: string;
      promptHash?: string; framework?: string; toolsUsed?: string[];
      testsRun?: boolean; typechecked?: boolean; extra?: Record<string, unknown>;
    };
    if (!body.repoId || !body.commitSha) throw new ValidationError("repoId + commitSha required");
    const row = await createAttestation(db, {
      repoId: body.repoId,
      changeId: body.changeId ?? null,
      commitSha: body.commitSha,
      agentId: p.agentId,
      agentVersion: body.agentVersion,
      modelName: body.modelName,
      modelVersion: body.modelVersion,
      promptHash: body.promptHash,
      framework: body.framework,
      toolsUsed: body.toolsUsed,
      testsRun: body.testsRun,
      typechecked: body.typechecked,
      extra: body.extra,
    });
    return c.json({ attestation: row }, 201);
  });

  app.get("/commit/:sha", async c => {
    const caller = c.get("tokenPayload");
    const rows = await listByCommit(db, c.req.param("sha"));
    // Provenance is private-repo sensitive: keep only attestations whose owning
    // repo this caller may READ. A single sha can span repos, so filter per-row
    // (cache the read decision per repoId to avoid re-querying).
    const readable = new Map<string, boolean>();
    const visible: typeof rows = [];
    for (const r of rows) {
      let ok = readable.get(r.repoId);
      if (ok === undefined) {
        const repo = (await db.select().from(repositories).where(eq(repositories.id, r.repoId)).limit(1))[0];
        ok = repo ? await requireRepoRead(db, repo, caller).then(() => true).catch(() => false) : false;
        readable.set(r.repoId, ok);
      }
      if (ok) visible.push(r);
    }
    const verified = await Promise.all(visible.map(r => verifyAttestation(db, r)));
    return c.json({ attestations: visible.map((r, i) => ({ ...r, verified: verified[i] })) });
  });

  app.get("/change/:id", async c => {
    const change = (await db.select().from(changes).where(eq(changes.id, c.req.param("id"))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    // Authorize the caller can READ the change's repo before returning its
    // provenance — 404 (no existence leak) on denied read.
    const repo = (await db.select().from(repositories).where(eq(repositories.id, change.repoId)).limit(1))[0];
    if (!repo) throw new NotFoundError("change");
    await requireRepoRead(db, repo, c.get("tokenPayload"));
    const rows = await listByChange(db, change.id);
    const verified = await Promise.all(rows.map(r => verifyAttestation(db, r)));
    return c.json({ attestations: rows.map((r, i) => ({ ...r, verified: verified[i] })) });
  });

  app.post("/keys/rotate", async c => {
    const p = c.get("tokenPayload");
    // Rotating the GLOBAL provenance signing key is a platform operation — gate
    // to the admin-email allowlist; any user could previously rotate it.
    if (p.kind !== "user" || !isPlatformAdminEmail(p.email)) throw new AuthError("not_admin");
    const { keyId } = await rotateSigningKey(db);
    return c.json({ keyId });
  });

  return app;
}
