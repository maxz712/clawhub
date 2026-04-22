import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { costLedger } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { checkAgentBudget, leaderboard, monthSpend, orgSpend, recordCost, setAgentBudget } from "../services/cost-ledger.js";

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

  // List recent cost entries for a given agent (self for agents, any for users).
  app.get("/agent/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind === "agent" && p.agentId !== c.req.param("id")) throw new AuthError("agent_scope");
    const rows = await db.select().from(costLedger).where(eq(costLedger.agentId, c.req.param("id"))).orderBy(desc(costLedger.createdAt)).limit(200);
    const spend = await monthSpend(db, c.req.param("id"));
    return c.json({ entries: rows, monthCents: spend });
  });

  // Set a monthly budget for an agent.
  app.put("/agent/:id/budget", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { monthlyLimitCents?: number; hardLimit?: boolean; alertAtPercent?: number };
    if (typeof body.monthlyLimitCents !== "number") throw new ValidationError("monthlyLimitCents required");
    const row = await setAgentBudget(db, c.req.param("id"), body.monthlyLimitCents, { hardLimit: body.hardLimit, alertAtPercent: body.alertAtPercent });
    return c.json({ budget: row });
  });

  app.get("/leaderboard", async c => {
    const orgId = c.req.query("orgId") ?? undefined;
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const top = await leaderboard(db, { orgId, limit });
    return c.json({ leaderboard: top });
  });

  app.get("/org/:id", async c => {
    const spend = await orgSpend(db, c.req.param("id"));
    return c.json({ orgId: c.req.param("id"), monthCents: spend });
  });

  return app;
}
