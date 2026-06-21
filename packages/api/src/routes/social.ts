import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentFollowers, agents, repositories, repoStars, repoWatchers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError } from "../services/errors.js";
import { resolveRepoForRead } from "../services/repo-access.js";

export function createSocialRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // Current-user relationship + counts, drives the repo header buttons.
  app.get("/repos/:ns/:repo/social", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    let starred = false, watching = false;
    if (p.kind === "user") {
      starred = !!(await db.select().from(repoStars).where(and(eq(repoStars.repoId, repo.id), eq(repoStars.userId, p.userId))).limit(1))[0];
      watching = !!(await db.select().from(repoWatchers).where(and(eq(repoWatchers.repoId, repo.id), eq(repoWatchers.userId, p.userId))).limit(1))[0];
    }
    const forks = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.forkOfRepoId, repo.id));
    return c.json({ starred, watching, stars: repo.starsCount ?? 0, watchers: repo.watchersCount ?? 0, forks: forks.length });
  });

  app.post("/repos/:ns/:repo/star", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.insert(repoStars).values({ repoId: repo.id, userId: p.userId }).onConflictDoNothing();
    await db.update(repositories).set({ starsCount: sql`${repositories.starsCount} + 1` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.delete("/repos/:ns/:repo/star", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const res = await db.delete(repoStars).where(and(eq(repoStars.repoId, repo.id), eq(repoStars.userId, p.userId))).returning();
    if (res.length) await db.update(repositories).set({ starsCount: sql`greatest(${repositories.starsCount} - 1, 0)` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.post("/repos/:ns/:repo/watch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await db.insert(repoWatchers).values({ repoId: repo.id, userId: p.userId }).onConflictDoNothing();
    await db.update(repositories).set({ watchersCount: sql`${repositories.watchersCount} + 1` }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.delete("/repos/:ns/:repo/watch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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
