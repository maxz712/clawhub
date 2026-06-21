import { Hono } from "hono";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, costLedger, orgAgentRegistry, orgMembers } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { TokenPayload } from "../services/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { checkAgentBudget, leaderboard, monthSpend, orgSpend, recordCost, setAgentBudget } from "../services/cost-ledger.js";

// Platform admins (CLAWHUB_ADMIN_EMAILS) may see the global, all-tenant board.
const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
function isAdmin(p: { kind: string; email?: string }): boolean {
  return p.kind === "user" && !!p.email && ADMIN_SET.has(p.email.toLowerCase());
}

// The agent IDs a user governs: agents they own (claimed = associatedUserId, or
// their service user) plus agents enrolled in the registries of orgs they belong
// to. Used to scope the cost board so a caller never sees another tenant's spend.
async function governedAgentIds(db: DB, userId: string): Promise<string[]> {
  const owned = await db.select({ id: agents.id }).from(agents)
    .where(or(eq(agents.associatedUserId, userId), eq(agents.serviceUserId, userId)));
  const ids = new Set(owned.map(a => a.id));
  const memberships = await db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, userId));
  const orgIds = memberships.map(m => m.orgId);
  if (orgIds.length) {
    const enrolled = await db.select({ agentId: orgAgentRegistry.agentId }).from(orgAgentRegistry).where(inArray(orgAgentRegistry.orgId, orgIds));
    for (const e of enrolled) ids.add(e.agentId);
  }
  return [...ids];
}

// Authorize a caller against a specific agent's cost data: the agent itself, a
// user who governs it (owned / shared-org-registry), or a platform admin.
// Missing/ungoverned agent → 404 (no existence leak).
async function requireAgentGoverned(db: DB, p: TokenPayload, agentId: string): Promise<void> {
  if (p.kind === "agent") {
    if (p.agentId !== agentId) throw new AuthError("agent_scope");
    return;
  }
  if (isAdmin(p)) return;
  const governed = await governedAgentIds(db, p.userId);
  if (!governed.includes(agentId)) throw new NotFoundError("agent");
}

export function createCostRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // An agent reports their own cost for a recently created change.
  app.post("/self", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agents only");
    const body = await c.req.json().catch(() => ({})) as { repoId?: string; changeId?: string; inputTokens?: number; outputTokens?: number; cachedTokens?: number; costCents?: number; model?: string; kind?: string };
    const row = await recordCost(db, {
      agentId: p.agentId,
      repoId: body.repoId ?? null,
      changeId: body.changeId ?? null,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      cachedTokens: body.cachedTokens,
      costCents: body.costCents,
      model: body.model,
      kind: body.kind,
    });
    const budget = await checkAgentBudget(db, p.agentId);
    return c.json({ entry: row, budget });
  });

  // List recent cost entries for a given agent (self for agents; users must
  // govern the agent — own it, share an org registry, or be admin). Previously
  // ANY user could read ANY agent's full spend ledger.
  app.get("/agent/:id", async c => {
    const p = c.get("tokenPayload");
    const id = c.req.param("id");
    await requireAgentGoverned(db, p, id);
    const rows = await db.select().from(costLedger).where(eq(costLedger.agentId, id)).orderBy(desc(costLedger.createdAt)).limit(200);
    const spend = await monthSpend(db, id);
    return c.json({ entries: rows, monthCents: spend });
  });

  // Set a monthly budget for an agent. Governance act — the caller must govern
  // the agent (own it / share an org registry / admin), not just hold any token.
  app.put("/agent/:id/budget", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireAgentGoverned(db, p, c.req.param("id"));
    const body = await c.req.json().catch(() => ({})) as { monthlyLimitCents?: number; hardLimit?: boolean; alertAtPercent?: number };
    if (typeof body.monthlyLimitCents !== "number") throw new ValidationError("monthlyLimitCents required");
    const row = await setAgentBudget(db, c.req.param("id"), body.monthlyLimitCents, { hardLimit: body.hardLimit, alertAtPercent: body.alertAtPercent });
    return c.json({ budget: row });
  });

  app.get("/leaderboard", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const orgId = c.req.query("orgId") ?? undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

    if (orgId) {
      // Org-scoped board: the caller must be a member (admin reads any). Without
      // this any user could read any org's per-agent spend by guessing its id.
      if (!isAdmin(p)) {
        const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
        if (!m) throw new NotFoundError("org");
      }
      return c.json({ leaderboard: await leaderboard(db, { orgId, limit }) });
    }

    // No org: the global, all-tenant board is admin-only. Everyone else gets a
    // board scoped to the agents they govern (owned + shared org registries) —
    // never platform-wide spend. (Previously this returned EVERY agent's spend.)
    if (isAdmin(p)) return c.json({ leaderboard: await leaderboard(db, { limit }) });
    const governed = new Set(await governedAgentIds(db, p.userId));
    if (!governed.size) return c.json({ leaderboard: [] });
    // Pull a generous global slice, then filter to governed agents. (No service
    // helper exists for "leaderboard by agent-id set"; this keeps the change in
    // the route without loosening the service contract.)
    const all = await leaderboard(db, { limit: 200 });
    const scoped = all.filter(r => governed.has(r.agentId)).slice(0, limit);
    return c.json({ leaderboard: scoped });
  });

  app.get("/org/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const orgId = c.req.param("id");
    // Org monthly spend is org-private — members only (admin reads any).
    if (!isAdmin(p)) {
      const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
      if (!m) throw new NotFoundError("org");
    }
    const spend = await orgSpend(db, orgId);
    return c.json({ orgId, monthCents: spend });
  });

  return app;
}
