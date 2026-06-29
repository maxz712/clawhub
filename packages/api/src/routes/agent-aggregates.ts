import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError } from "../services/errors.js";
import { namespaceNameOf } from "../services/namespace.js";
import { listStandingAgentsForRepos, redactStanding } from "../services/standing-agents.js";
import { listReposMemories, redactMemory } from "../services/memory.js";
import { killedAgentSet } from "../services/kill-switch.js";

// Cross-repo agent aggregates for the unified Agents hub: "all my standing
// agents" and "all my agent memory" in one view, instead of one repo at a time.
// Each row carries its repo's ns/name so the dashboard can route per-row actions
// (run/pause/delete, pin/archive) back to the existing repo-scoped endpoints.
// Mounted at specific prefixes (not a bare /api/v1) so the `use("*")` auth here
// can't shadow other /api/v1/* routers.

// Resolve every repo a USER governs — mirrors routes/repos.ts GET / (user
// branch): repos under their handle, their claimed agents' service-user repos,
// their orgs' repos, and legacy agent-owned repos.
async function listUserRepos(db: DB, userId: string): Promise<Array<typeof repositories.$inferSelect>> {
  const result: Array<typeof repositories.$inferSelect> = [];
  const seen = new Set<string>();
  const add = (rows: Array<typeof repositories.$inferSelect>) => { for (const r of rows) if (!seen.has(r.id)) { result.push(r); seen.add(r.id); } };
  const ownedAgents = await db.select().from(agents).where(eq(agents.associatedUserId, userId));
  const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
  const ownerUserIds = [userId, ...ownedAgents.map(a => a.serviceUserId).filter((x): x is string => !!x)];
  add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "user"), inArray(repositories.namespaceId, ownerUserIds))));
  for (const m of memberships) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, m.orgId))));
  for (const a of ownedAgents) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, a.id))));
  return result;
}

async function repoLabels(db: DB, repos: Array<typeof repositories.$inferSelect>): Promise<Map<string, { ns: string | null; name: string }>> {
  const map = new Map<string, { ns: string | null; name: string }>();
  for (const r of repos) map.set(r.id, { ns: await namespaceNameOf(db, r.namespaceType, r.namespaceId), name: r.name });
  return map;
}

// GET /api/v1/standing-agents — every standing agent across the caller's repos.
export function createStandingFleetRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const repos = await listUserRepos(db, p.userId);
    const labels = await repoLabels(db, repos);
    const rows = await listStandingAgentsForRepos(db, repos.map(r => r.id));
    const killed = await killedAgentSet(db, rows.map(r => r.agentId));
    return c.json({
      standingAgents: rows.map(r => {
        const l = labels.get(r.repoId);
        return { ...redactStanding(r), killed: killed.has(r.agentId), repoNs: l?.ns ?? null, repoName: l?.name ?? null };
      }),
    });
  });
  return app;
}

// GET /api/v1/memory — agent memory across the caller's repos (human view).
export function createMemoryFleetRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const q = c.req.query();
    const repos = await listUserRepos(db, p.userId);
    const labels = await repoLabels(db, repos);
    const rows = await listReposMemories(db, repos.map(r => r.id), {
      kind: q.kind,
      includeArchived: q.archived === "1",
      limit: q.limit ? Math.min(500, Number(q.limit)) : undefined,
    });
    const agentIds = [...new Set(rows.map(r => r.agentId).filter((x): x is string => !!x))];
    const names = agentIds.length
      ? Object.fromEntries((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map(a => [a.id, a.name]))
      : {};
    return c.json({
      memories: rows.map(r => {
        const l = r.repoId ? labels.get(r.repoId) : undefined;
        return { ...redactMemory(r), agentName: r.agentId ? (names[r.agentId] ?? null) : null, repoNs: l?.ns ?? null, repoName: l?.name ?? null };
      }),
    });
  });
  return app;
}
