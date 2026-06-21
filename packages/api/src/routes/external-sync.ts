import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { resolveRepoForWrite } from "../services/repo-access.js";
import { handleJira, handleLinear } from "../services/external-sync.js";

export function createExternalSyncRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Jira webhook. Configure Jira to POST here; user auth required to prove ownership.
  app.post("/:ns/:repo/jira", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const payload = await c.req.json().catch(() => ({}));
    const result = await handleJira(db, repo.id, payload, { kind: "human", id: p.userId });
    return c.json(result);
  });

  app.post("/:ns/:repo/linear", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const payload = await c.req.json().catch(() => ({}));
    const result = await handleLinear(db, repo.id, payload, { kind: "human", id: p.userId });
    return c.json(result);
  });

  return app;
}
