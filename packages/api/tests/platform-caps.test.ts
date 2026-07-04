import { describe, it, expect, afterEach } from "vitest";
import { entitlementsFor, TIERS } from "../src/services/entitlements.js";
import { decideBudget } from "../src/services/platform-billing.js";
import { globalCapMicroUsd } from "../src/services/platform-quota.js";

// D10 — the sized, adversarially-verified cap set. These assert the NUMBERS the cost
// model depends on (a silent drift here is a margin/abuse regression).

describe("D10 entitlement sizing", () => {
  it("free is a HARD per-tenant cap: 100/mo, 10/day, 3 repos, 2M/120k tokens, 0 verify", () => {
    const f = entitlementsFor("free");
    expect(f.platformReviews).toBe(100);
    expect(f.reviewDailyCap).toBe(10);
    expect(f.reviewMaxRepos).toBe(3);
    expect(f.inputTokensMonthly).toBe(2_000_000);
    expect(f.inputTokensDaily).toBe(120_000);
    expect(f.verifyCredits).toBe(0);           // free = zero platform verify
    expect(f.standingAgents).toBe(0);
  });
  it("pro pool is 250 (halved from 500) + 10 verify credits, soft/metered above", () => {
    const p = entitlementsFor("pro");
    expect(p.platformReviews).toBe(250);
    expect(p.verifyCredits).toBe(10);
    expect(p.reviewDailyCap).toBe(Infinity);   // paid = no hard count cap (billed)
    expect(p.reviewMaxRepos).toBe(Infinity);
    expect(p.inputTokensMonthly).toBe(Infinity);
  });
  it("enterprise is unmetered", () => {
    expect(entitlementsFor("enterprise").platformReviews).toBe(Infinity);
    expect(entitlementsFor("enterprise").verifyCredits).toBe(Infinity);
  });
  it("every tier has the full D10 field set (no undefined caps)", () => {
    for (const plan of Object.keys(TIERS) as (keyof typeof TIERS)[]) {
      const e = TIERS[plan];
      for (const k of ["platformReviews", "verifyCredits", "reviewDailyCap", "reviewMaxRepos", "inputTokensMonthly", "inputTokensDaily"] as const) {
        expect(typeof e[k]).toBe("number");
      }
    }
  });
});

describe("decideBudget", () => {
  it("proceeds under cap, fires the configured onExhaust at/over cap", () => {
    expect(decideBudget(50, 100, "block", 80).mode).toBe("proceed");
    expect(decideBudget(100, 100, "block", 80).mode).toBe("block");
    expect(decideBudget(120, 100, "byo_fallback", 80).mode).toBe("byo_fallback");
    expect(decideBudget(120, 100, "queue", 80).mode).toBe("queue");
  });
  it("cap<=0 disables the budget (proceed, no cap)", () => {
    const d = decideBudget(999, 0, "block", 80);
    expect(d.mode).toBe("proceed"); expect(d.capMicroUsd).toBeNull();
  });
  it("alert flips at the % line", () => {
    expect(decideBudget(79, 100, "block", 80).alert).toBe(false);
    expect(decideBudget(80, 100, "block", 80).alert).toBe(true);
  });
});

describe("global spend ceiling (the $100 backstop)", () => {
  const saved = process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP;
  afterEach(() => { if (saved === undefined) delete process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP; else process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP = saved; });
  it("defaults to $100 in micro-USD", () => {
    delete process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP;
    expect(globalCapMicroUsd()).toBe(100_000_000);
  });
  it("honors an override and disables on <=0 / non-numeric", () => {
    process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP = "80";
    expect(globalCapMicroUsd()).toBe(80_000_000);
    process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP = "0";
    expect(globalCapMicroUsd()).toBe(0);
    process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP = "nope";
    expect(globalCapMicroUsd()).toBe(0);
  });
});
