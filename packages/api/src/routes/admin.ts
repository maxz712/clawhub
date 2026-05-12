import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, auditEvents, gitShards, organizations, repoShards, repositories, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { reapStaleLeases } from "../services/leader-election.js";
import { ShardMap } from "../services/shard-map.js";

// Admins are marked via CLAWHUB_ADMIN_EMAILS env var (comma-separated list).
// In real deployments this becomes a row-level admin flag; the env approach
// keeps bootstrap simple and auditable.
const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

async function ensureAdmin(c: { get: (k: "tokenPayload") => { kind: "user" | "agent"; userId?: string; email?: string } }): Promise<void> {
  const p = c.get("tokenPayload");
  if (p.kind !== "user") throw new AuthError("users only");
  if (!p.email || !ADMIN_SET.has(p.email.toLowerCase())) throw new AuthError("not_admin");
}

export function createAdminRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.get("/users", async c => {
    await ensureAdmin(c);
    const rows = await db.select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt, totpEnabled: users.totpEnabled }).from(users).orderBy(desc(users.createdAt)).limit(500);
    return c.json({ users: rows });
  });

  app.delete("/users/:id", async c => {
    await ensureAdmin(c);
    const res = await db.delete(users).where(eq(users.id, c.req.param("id"))).returning();
    if (!res.length) throw new NotFoundError("user");
    return c.json({ ok: true });
  });

  app.get("/orgs", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(organizations).orderBy(desc(organizations.createdAt)).limit(500);
    return c.json({ orgs: rows });
  });

  app.get("/agents", async c => {
    await ensureAdmin(c);
    const rows = await db.select({ id: agents.id, name: agents.name, createdAt: agents.createdAt, associatedUserId: agents.associatedUserId }).from(agents).orderBy(desc(agents.createdAt)).limit(500);
    return c.json({ agents: rows });
  });

  app.get("/repos", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(repositories).orderBy(desc(repositories.createdAt)).limit(500);
    return c.json({ repos: rows });
  });

  app.get("/stats", async c => {
    await ensureAdmin(c);
    const [{ usersN }] = await db.select({ usersN: sql<number>`count(*)::int` }).from(users);
    const [{ orgsN }] = await db.select({ orgsN: sql<number>`count(*)::int` }).from(organizations);
    const [{ agentsN }] = await db.select({ agentsN: sql<number>`count(*)::int` }).from(agents);
    const [{ reposN }] = await db.select({ reposN: sql<number>`count(*)::int` }).from(repositories);
    return c.json({ users: Number(usersN), orgs: Number(orgsN), agents: Number(agentsN), repos: Number(reposN) });
  });

  // Phase 3/4 shard admin. See packages/git-service for the data-plane side.
  app.get("/shards", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(gitShards);
    return c.json({ shards: rows });
  });

  app.post("/shards", async c => {
    await ensureAdmin(c);
    const body = await c.req.json() as { id: string; endpoint: string; role?: "primary" | "replica" };
    if (!body.id || !body.endpoint) throw new ValidationError("id and endpoint required");
    await db.insert(gitShards).values({ id: body.id, endpoint: body.endpoint, role: body.role ?? "primary" })
      .onConflictDoUpdate({ target: gitShards.id, set: { endpoint: body.endpoint, role: body.role ?? "primary" } });
    return c.json({ ok: true });
  });

  app.delete("/shards/:id", async c => {
    await ensureAdmin(c);
    const res = await db.delete(gitShards).where(eq(gitShards.id, c.req.param("id"))).returning();
    if (!res.length) throw new NotFoundError("shard");
    return c.json({ ok: true });
  });

  app.post("/shards/reap-leases", async c => {
    await ensureAdmin(c);
    const n = await reapStaleLeases(db);
    return c.json({ reaped: n });
  });

  app.post("/shards/place/:repoId", async c => {
    await ensureAdmin(c);
    const map = new ShardMap(db);
    const placed = await map.placeNew(c.req.param("repoId"));
    return c.json({ shard: placed });
  });

  app.get("/shards/placements", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(repoShards).limit(1000);
    return c.json({ placements: rows });
  });

  // SIEM export of audit events as NDJSON. Stream-friendly for large windows.
  app.get("/audit/export", async c => {
    await ensureAdmin(c);
    const limit = Math.min(Number(c.req.query("limit") ?? 10_000), 100_000);
    const rows = await db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit);
    const body = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
    return c.body(body, 200, { "content-type": "application/x-ndjson", "content-disposition": 'attachment; filename="audit.ndjson"' });
  });

  return app;
}
