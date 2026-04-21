import { and, eq, gte, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { costBudgets, costLedger, organizations } from "../models/schema.js";

export interface CostEntryInput {
  agentId: string;
  repoId?: string | null;
  changeId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  costCents?: number;
  model?: string;
  kind?: string;
}

export async function recordCost(db: DB, input: CostEntryInput) {
  const [row] = await db.insert(costLedger).values({
    agentId: input.agentId,
    repoId: input.repoId ?? null,
    changeId: input.changeId ?? null,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cachedTokens: input.cachedTokens ?? 0,
    costCents: input.costCents ?? 0,
    model: input.model ?? null,
    kind: input.kind ?? "change",
  }).returning();
  return row;
}

export async function monthSpend(db: DB, agentId: string, at: Date = new Date()): Promise<number> {
  const start = new Date(at.getFullYear(), at.getMonth(), 1);
  const [r] = await db.select({ sum: sql<number>`coalesce(sum(${costLedger.costCents}), 0)::int` })
    .from(costLedger)
    .where(and(eq(costLedger.agentId, agentId), gte(costLedger.createdAt, start)));
  return Number(r?.sum ?? 0);
}

export async function orgSpend(db: DB, orgId: string, at: Date = new Date()): Promise<number> {
  const start = new Date(at.getFullYear(), at.getMonth(), 1);
  const [r] = await db.execute<{ sum: string }>(sql`
    select coalesce(sum(cl.cost_cents), 0)::text as sum
    from cost_ledger cl
    join repositories r on r.id = cl.repo_id
    where r.namespace_type = 'org' and r.namespace_id = ${orgId}
      and cl.created_at >= ${start}
  `);
  return Number(r?.sum ?? 0);
}

export interface BudgetCheck {
  ok: boolean;
  spentCents: number;
  limitCents: number;
  percentUsed: number;
  shouldAlert: boolean;
}

export async function checkAgentBudget(db: DB, agentId: string): Promise<BudgetCheck> {
  const budget = (await db.select().from(costBudgets).where(eq(costBudgets.agentId, agentId)).limit(1))[0];
  if (!budget || budget.monthlyLimitCents === 0) {
    return { ok: true, spentCents: 0, limitCents: 0, percentUsed: 0, shouldAlert: false };
  }
  const spent = await monthSpend(db, agentId);
  const pct = Math.round((spent / budget.monthlyLimitCents) * 100);
  return {
    ok: !budget.hardLimit || spent < budget.monthlyLimitCents,
    spentCents: spent,
    limitCents: budget.monthlyLimitCents,
    percentUsed: pct,
    shouldAlert: pct >= budget.alertAtPercent,
  };
}

export async function setAgentBudget(db: DB, agentId: string, limitCents: number, opts: { hardLimit?: boolean; alertAtPercent?: number } = {}) {
  const existing = (await db.select().from(costBudgets).where(eq(costBudgets.agentId, agentId)).limit(1))[0];
  const values = {
    agentId,
    monthlyLimitCents: limitCents,
    hardLimit: opts.hardLimit ?? false,
    alertAtPercent: opts.alertAtPercent ?? 80,
  };
  if (existing) {
    const [row] = await db.update(costBudgets).set(values).where(eq(costBudgets.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(costBudgets).values(values).returning();
  return row;
}

export async function leaderboard(db: DB, opts: { orgId?: string; limit?: number } = {}) {
  const limit = opts.limit ?? 50;
  if (opts.orgId) {
    const rows = await db.execute<{ agent_id: string; cost_cents: string; input_tokens: string; output_tokens: string }>(sql`
      select cl.agent_id::text, sum(cl.cost_cents)::text as cost_cents,
        sum(cl.input_tokens)::text as input_tokens,
        sum(cl.output_tokens)::text as output_tokens
      from cost_ledger cl
      join repositories r on r.id = cl.repo_id
      where r.namespace_type = 'org' and r.namespace_id = ${opts.orgId}
        and cl.created_at >= date_trunc('month', now())
      group by cl.agent_id
      order by sum(cl.cost_cents) desc
      limit ${limit}
    `);
    // `db.execute` may return `rows` in `{ rows: [...] }` shape on drizzle-postgres.
    const arr = Array.isArray(rows) ? rows : ((rows as unknown as { rows?: unknown[] }).rows ?? []);
    return (arr as Array<{ agent_id: string; cost_cents: string; input_tokens: string; output_tokens: string }>).map(r => ({
      agentId: r.agent_id, costCents: Number(r.cost_cents), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
    }));
  }
  const rows = await db.execute<{ agent_id: string; cost_cents: string; input_tokens: string; output_tokens: string }>(sql`
    select agent_id::text, sum(cost_cents)::text as cost_cents,
      sum(input_tokens)::text as input_tokens, sum(output_tokens)::text as output_tokens
    from cost_ledger where created_at >= date_trunc('month', now())
    group by agent_id order by sum(cost_cents) desc limit ${limit}
  `);
  const arr = Array.isArray(rows) ? rows : ((rows as unknown as { rows?: unknown[] }).rows ?? []);
  return (arr as Array<{ agent_id: string; cost_cents: string; input_tokens: string; output_tokens: string }>).map(r => ({
    agentId: r.agent_id, costCents: Number(r.cost_cents), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens),
  }));
}
