import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, costBudgets, costLedger, organizations } from "../models/schema.js";
import { queueEmail } from "./notifications.js";

// A budget alert is recorded as a zero-cost ledger row of this kind so the
// "already alerted this period" check is durable + race-light without a schema
// change. One marker per agent per month means the alert is delivered exactly
// once per threshold crossing (it does NOT re-fire every recordCost after).
const BUDGET_ALERT_KIND = "budget_alert";

/** First instant of the current calendar month (local time, matching monthSpend). */
function monthStart(at: Date = new Date()): Date {
  return new Date(at.getFullYear(), at.getMonth(), 1);
}

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
  // Deliver the budget alert once per threshold crossing per period. Best-effort:
  // a notification failure must never fail cost recording (the agent's run is the
  // source of truth for spend).
  try {
    await maybeAlertBudget(db, input.agentId);
  } catch {
    /* alerting is advisory; swallow so spend is always recorded */
  }
  return row;
}

/**
 * If the agent has just crossed (or is over) its alert threshold and we have not
 * already alerted in the current month, persist a one-per-period marker and email
 * the agent's owner. Idempotent: the marker insert is the de-dup, so concurrent
 * recordCost calls at most race to insert one marker and send one email.
 */
async function maybeAlertBudget(db: DB, agentId: string): Promise<void> {
  const check = await checkAgentBudget(db, agentId);
  if (!check.shouldAlert) return;

  const start = monthStart();
  // Already alerted this period? (zero-cost marker row this month)
  const existing = (await db.select({ id: costLedger.id }).from(costLedger)
    .where(and(eq(costLedger.agentId, agentId), eq(costLedger.kind, BUDGET_ALERT_KIND), gte(costLedger.createdAt, start)))
    .limit(1))[0];
  if (existing) return;

  // Record the marker first so a concurrent caller short-circuits above; the email
  // is the side effect after the durable de-dup.
  await db.insert(costLedger).values({ agentId, costCents: 0, kind: BUDGET_ALERT_KIND });

  // Notify the human who owns the agent (claimed user, else service user).
  const agent = (await db.select({ name: agents.name, associatedUserId: agents.associatedUserId, serviceUserId: agents.serviceUserId })
    .from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  const ownerUserId = agent?.associatedUserId ?? agent?.serviceUserId ?? null;
  if (!ownerUserId) return;

  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const over = !check.ok ? " — the hard limit is now exceeded and dispatches are blocked" : "";
  await queueEmail(
    db,
    ownerUserId,
    `Agent "${agent?.name ?? agentId}" reached ${check.percentUsed}% of its monthly budget`,
    `Agent "${agent?.name ?? agentId}" has spent ${dollars(check.spentCents)} of its ${dollars(check.limitCents)} monthly cost budget (${check.percentUsed}%)${over}.\n\nReview or adjust the budget in your fleet cost settings.`,
    "emailOnCiFailure",
  );
}

export async function monthSpend(db: DB, agentId: string, at: Date = new Date()): Promise<number> {
  const start = new Date(at.getFullYear(), at.getMonth(), 1);
  const [r] = await db.select({ sum: sql<number>`coalesce(sum(${costLedger.costCents}), 0)::int` })
    .from(costLedger)
    .where(and(eq(costLedger.agentId, agentId), gte(costLedger.createdAt, start)));
  return Number(r?.sum ?? 0);
}

// Month-to-date spend ATTRIBUTED to the org's repos (cost_ledger rows whose
// repo_id resolves to an org-owned repo). This is the org budget's scope by
// design: it caps spend ON the org's repos, not an enrolled agent's spend
// elsewhere. cost_ledger rows with a NULL/non-org repo_id are intentionally
// excluded — they aren't this org's repo spend. (Each agent's own per-agent cap,
// keyed on agentId regardless of repo, still bounds that agent's total spend.)
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

// ── Org-wide budgets (the org cap on its agents' total monthly spend) ──────────
// An org budget is a costBudgets row keyed by orgId with a NULL agentId (so it
// can't collide with a per-agent budget). Enforcement is min(agent cap, org cap):
// a dispatch for an org repo is blocked if EITHER hard limit is exceeded.
export async function getOrgBudget(db: DB, orgId: string) {
  return (await db.select().from(costBudgets).where(and(eq(costBudgets.orgId, orgId), isNull(costBudgets.agentId))).limit(1))[0] ?? null;
}

export async function checkOrgBudget(db: DB, orgId: string): Promise<BudgetCheck> {
  const budget = await getOrgBudget(db, orgId);
  if (!budget || budget.monthlyLimitCents === 0) {
    return { ok: true, spentCents: 0, limitCents: 0, percentUsed: 0, shouldAlert: false };
  }
  const spent = await orgSpend(db, orgId);
  const pct = Math.round((spent / budget.monthlyLimitCents) * 100);
  return {
    ok: !budget.hardLimit || spent < budget.monthlyLimitCents,
    spentCents: spent,
    limitCents: budget.monthlyLimitCents,
    percentUsed: pct,
    shouldAlert: pct >= budget.alertAtPercent,
  };
}

export async function setOrgBudget(db: DB, orgId: string, limitCents: number, opts: { hardLimit?: boolean; alertAtPercent?: number } = {}) {
  const existing = await getOrgBudget(db, orgId);
  const values = {
    orgId, agentId: null,
    monthlyLimitCents: limitCents,
    hardLimit: opts.hardLimit ?? true,
    alertAtPercent: opts.alertAtPercent ?? 80,
  };
  if (existing) {
    const [row] = await db.update(costBudgets).set(values).where(eq(costBudgets.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(costBudgets).values(values).returning();
  return row;
}

export async function setAgentBudget(db: DB, agentId: string, limitCents: number, opts: { hardLimit?: boolean; alertAtPercent?: number } = {}) {
  const existing = (await db.select().from(costBudgets).where(eq(costBudgets.agentId, agentId)).limit(1))[0];
  const values = {
    agentId,
    monthlyLimitCents: limitCents,
    // Enforce-by-default: a budget set without an explicit choice BITES (blocks
    // dispatch over the limit). A caller wanting alert-only must opt in with
    // hardLimit:false. A budget that didn't enforce was just a decoration.
    hardLimit: opts.hardLimit ?? true,
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
