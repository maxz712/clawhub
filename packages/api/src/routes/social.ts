import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentFollowers, agents, repositories, repoStars, repoWatchers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import { mustResolveRepo } from "../services/repo-resolver.js";

export function createSocialRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/repos/:ns/:repo/star", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await db.insert(repoStars).values({ repoId: repo.id, userId: p.userId }).onConflictDoNothing();
    await db.update(repositories).set({ starsCount: sql`${repositories.starsCount} + 1` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.delete("/repos/:ns/:repo/star", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const res = await db.delete(repoStars).where(and(eq(repoStars.repoId, repo.id), eq(repoStars.userId, p.userId))).returning();
    if (res.length) await db.update(repositories).set({ starsCount: sql`greatest(${repositories.starsCount} - 1, 0)` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.post("/repos/:ns/:repo/watch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await db.insert(repoWatchers).values({ repoId: repo.id, userId: p.userId }).onConflictDoNothing();
    await db.update(repositories).set({ watchersCount: sql`${repositories.watchersCount} + 1` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.delete("/repos/:ns/:repo/watch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const res = await db.delete(repoWatchers).where(and(eq(repoWatchers.repoId, repo.id), eq(repoWatchers.userId, p.userId))).returning();
    if (res.length) await db.update(repositories).set({ watchersCount: sql`greatest(${repositories.watchersCount} - 1, 0)` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.post("/agents/:name/follow", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const agent = (await db.select().from(agents).where(eq(agents.name, c.req.param("name"))).limit(1))[0];
    if (!agent) throw new NotFoundError("agent");
    await db.insert(agentFollowers).values({ agentId: agent.id, userId: p.userId }).onConflictDoNothing();
    return c.json({ ok: true });
  });

  app.delete("/agents/:name/follow", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const agent = (await db.select().from(agents).where(eq(agents.name, c.req.param("name"))).limit(1))[0];
    if (!agent) throw new NotFoundError("agent");
    await db.delete(agentFollowers).where(and(eq(agentFollowers.agentId, agent.id), eq(agentFollowers.userId, p.userId)));
    return c.json({ ok: true });
  });

  return app;
}
