import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { heartbeat, viewers } from "../services/presence.js";
import { NotFoundError } from "../services/errors.js";
import { and, eq } from "drizzle-orm";
import { changes } from "../models/schema.js";

export function createPresenceRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/:ns/:repo/changes/:id/presence", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    await heartbeat(db, change.id, { kind: p.kind === "user" ? "human" : "agent", id: p.kind === "user" ? p.userId : p.agentId });
    const list = await viewers(db, change.id);
    return c.json({ viewers: list });
  });

  app.get("/:ns/:repo/changes/:id/presence", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const list = await viewers(db, change.id);
    return c.json({ viewers: list });
  });

  return app;
}
