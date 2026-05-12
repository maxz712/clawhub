import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, auditEvents, gitShards, organizations, repoBackups, repoMigrations, repoShards, repositories, shardReplicationState, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { reapStaleLeases } from "../services/leader-election.js";
import { ShardMap } from "../services/shard-map.js";
import type { EventBus } from "../services/events.js";
import { GitClientPool } from "../services/git-client.js";
import { ShardWatcher } from "../services/shard-watcher.js";
import { ShardMigrationService } from "../services/shard-migration.js";
import { ShardBackupService } from "../services/shard-backup.js";
import { buildObjectStoreFromEnv } from "../services/object-store.js";

// Admins are marked via CLAWHUB_ADMIN_EMAILS env var (comma-separated list).
// In real deployments this becomes a row-level admin flag; the env approach
// keeps bootstrap simple and auditable.
const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

async function ensureAdmin(c: { get: (k: "tokenPayload") => { kind: "user" | "agent"; userId?: string; email?: string } }): Promise<void> {
  const p = c.get("tokenPayload");
  if (p.kind !== "user") throw new AuthError("users only");
  if (!p.email || !ADMIN_SET.has(p.email.toLowerCase())) throw new AuthError("not_admin");
}

export interface AdminRoutesDeps {
  events?: EventBus;
  gitClients?: GitClientPool;
}

export function createAdminRoutes(db: DB, deps: AdminRoutesDeps = {}): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  const events = deps.events;
  const clients = deps.gitClients ?? new GitClientPool();
  const watcher = events ? new ShardWatcher(db, events) : null;
  const migrations = new ShardMigrationService(db, clients);
  const backups = new ShardBackupService(db, clients, buildObjectStoreFromEnv("./data/backups"));

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

  // Drain a shard: no new repos placed there, existing repos enqueue migrations.
  app.post("/shards/:id/drain", async c => {
    await ensureAdmin(c);
    const id = c.req.param("id");
    await db.update(gitShards).set({ status: "draining" }).where(eq(gitShards.id, id));

    // Pick other healthy primaries to take the load.
    const targets = await db.select().from(gitShards).where(and(eq(gitShards.role, "primary"), eq(gitShards.status, "healthy")));
    const alternates = targets.filter(t => t.id !== id);
    if (!alternates.length) return c.json({ error: "no_healthy_alternate_shards" }, 409);

    const reposHere = await db.select().from(repoShards).where(eq(repoShards.primaryShardId, id));
    const enqueued: Array<{ repoId: string; migrationId: string }> = [];
    for (let i = 0; i < reposHere.length; i++) {
      const repo = reposHere[i];
      const dest = alternates[i % alternates.length];
      try {
        const { id: mid } = await migrations.enqueue(repo.repoId, dest.id);
        enqueued.push({ repoId: repo.repoId, migrationId: mid });
      } catch (e) {
        // skip already-migrating repos
      }
    }
    return c.json({ shard: id, enqueued, total: reposHere.length });
  });

  // Force a specific replica to become primary for a repo.
  app.post("/shards/promote/:repoId", async c => {
    await ensureAdmin(c);
    if (!watcher) return c.json({ error: "event_bus_unavailable" }, 500);
    const body = await c.req.json() as { toShardId: string };
    if (!body.toShardId) throw new ValidationError("toShardId required");
    await watcher.promoteManual(c.req.param("repoId"), body.toShardId);
    return c.json({ ok: true });
  });

  app.get("/shards/:id/repos", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(repoShards).where(eq(repoShards.primaryShardId, c.req.param("id"))).limit(2000);
    return c.json({ repos: rows });
  });

  app.get("/shards/:id/replication-lag", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(shardReplicationState).where(eq(shardReplicationState.shardId, c.req.param("id"))).limit(2000);
    return c.json({ replication: rows });
  });

  // Resumable repo migrations.
  app.post("/shards/migrate/:repoId", async c => {
    await ensureAdmin(c);
    const body = await c.req.json() as { toShardId: string };
    if (!body.toShardId) throw new ValidationError("toShardId required");
    const r = await migrations.enqueue(c.req.param("repoId"), body.toShardId);
    return c.json(r, r.existing ? 200 : 201);
  });

  app.post("/migrations/:id/run", async c => {
    await ensureAdmin(c);
    await migrations.run(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/migrations", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(repoMigrations).orderBy(desc(repoMigrations.createdAt)).limit(200);
    return c.json({ migrations: rows });
  });

  // Backups.
  app.post("/repos/:repoId/backups", async c => {
    await ensureAdmin(c);
    const out = await backups.backupRepo(c.req.param("repoId"));
    return c.json(out);
  });

  app.get("/repos/:repoId/backups", async c => {
    await ensureAdmin(c);
    const rows = await db.select().from(repoBackups).where(eq(repoBackups.repoId, c.req.param("repoId"))).orderBy(desc(repoBackups.createdAt)).limit(100);
    return c.json({ backups: rows });
  });

  app.post("/repos/:repoId/restore", async c => {
    await ensureAdmin(c);
    const body = await c.req.json() as { backupId: string; toShardId: string };
    if (!body.backupId || !body.toShardId) throw new ValidationError("backupId and toShardId required");
    await backups.restoreRepo(c.req.param("repoId"), body.backupId, body.toShardId);
    return c.json({ ok: true });
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
