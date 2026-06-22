import { describe, it, expect } from "vitest";
import { checkOrgBudget } from "../src/services/cost-ledger.js";
import { costBudgets } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// Batch 7: cost_budgets.orgId was a dead column — no org-wide cap existed. These
// assert the new org budget enforces (hard limit blocks once spend reaches the
// limit) and stays advisory when hardLimit is false.
function makeDb(budget: Record<string, unknown> | null, spentCents: number): DB {
  const db = {
    select: (_c?: unknown) => ({ from: (t: unknown) => {
      const rows = t === costBudgets && budget ? [budget] : [];
      const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)), then: (r: (v: unknown[]) => void) => r(rows) };
      return chain as typeof chain & PromiseLike<unknown[]>;
    } }),
    execute: async () => [{ sum: String(spentCents) }],
  };
  return db as unknown as DB;
}

describe("checkOrgBudget", () => {
  it("no budget (or zero limit) → ok, never blocks", async () => {
    expect((await checkOrgBudget(makeDb(null, 99999), "o1")).ok).toBe(true);
    expect((await checkOrgBudget(makeDb({ monthlyLimitCents: 0, hardLimit: true, alertAtPercent: 80 }, 99999), "o1")).ok).toBe(true);
  });

  it("hard limit blocks once spend reaches the limit", async () => {
    const budget = { monthlyLimitCents: 1000, hardLimit: true, alertAtPercent: 80 };
    expect(await checkOrgBudget(makeDb(budget, 500), "o1")).toMatchObject({ ok: true, percentUsed: 50 });
    expect((await checkOrgBudget(makeDb(budget, 1000), "o1")).ok).toBe(false);
    expect((await checkOrgBudget(makeDb(budget, 1200), "o1")).ok).toBe(false);
  });

  it("alert-only budget (hardLimit false) never blocks but flags shouldAlert", async () => {
    const budget = { monthlyLimitCents: 1000, hardLimit: false, alertAtPercent: 80 };
    const over = await checkOrgBudget(makeDb(budget, 1200), "o1");
    expect(over.ok).toBe(true);
    expect(over.shouldAlert).toBe(true);
    expect(over.percentUsed).toBe(120);
  });
});
