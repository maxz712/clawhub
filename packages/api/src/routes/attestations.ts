import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { attestations, changes } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
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
    const rows = await listByCommit(db, c.req.param("sha"));
    const verified = await Promise.all(rows.map(r => verifyAttestation(db, r)));
    return c.json({ attestations: rows.map((r, i) => ({ ...r, verified: verified[i] })) });
  });

  app.get("/change/:id", async c => {
    const change = (await db.select().from(changes).where(eq(changes.id, c.req.param("id"))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const rows = await listByChange(db, change.id);
    const verified = await Promise.all(rows.map(r => verifyAttestation(db, r)));
    return c.json({ attestations: rows.map((r, i) => ({ ...r, verified: verified[i] })) });
  });

  app.post("/keys/rotate", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { keyId } = await rotateSigningKey(db);
    return c.json({ keyId });
  });

  return app;
}
