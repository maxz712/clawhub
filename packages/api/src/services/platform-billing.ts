import { and, eq, gte, isNull, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, platformBudgets, platformUsage, repositories, standingAgents } from "../models/schema.js";
import { planFor, entitlementsFor } from "./entitlements.js";
import { metrics } from "./metrics.js";
import { log } from "./logger.js";

// Platform-spend billing (M7). Metering (M3) records authoritative usage; this
// enforces per-tenant BUDGETS at dispatch, stamps a metered SKU per run, and a
// 5-min reporter pushes overage to Stripe. SKU prices per D1: $0.10/review
// overage, $2.00/verify. Budgets and pool accounting are the firewall the
// strategy calls for BEFORE the platform-keyed feature scales.

export const REVIEW_OVERAGE_MICRO_USD = 100_000;   // $0.10
export const VERIFY_RUN_MICRO_USD = 2_000_000;     // $2.00

export type OnExhaust = "byo_fallback" | "queue" | "block";
export type BudgetMode = "proceed" | "byo_fallback" | "queue" | "block";

function monthStartUtc(now = Date.now()): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export interface Tenant { orgId: string | null; userId: string | null }

/** Resolve the billing tenant (org XOR user) that owns a repo, via its namespace. */
export async function tenantForRepo(db: DB, repoId: string): Promise<Tenant> {
  const repo = (await db.select({ nsType: repositories.namespaceType, nsId: repositories.namespaceId }).from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (repo?.nsType === "org") return { orgId: repo.nsId, userId: null };
  if (repo?.nsType === "user") return { orgId: null, userId: repo.nsId };
  return { orgId: null, userId: null };
}

/** Month-to-date authoritative platform spend (micro-USD) for a tenant. */
export async function tenantMonthlySpendMicroUsd(db: DB, t: Tenant): Promise<number> {
  const who = t.orgId ? eq(platformUsage.orgId, t.orgId) : t.userId ? eq(platformUsage.userId, t.userId) : null;
  if (!who) return 0;
  const [r] = await db.select({ sum: sql<number>`coalesce(sum(${platformUsage.costMicroUsd}), 0)::bigint` })
    .from(platformUsage).where(and(who, gte(platformUsage.createdAt, monthStartUtc())));
  return Number(r?.sum ?? 0);
}

export interface BudgetDecision { mode: BudgetMode; spentMicroUsd: number; capMicroUsd: number | null; alert: boolean }

/** Pure budget decision: over cap → the configured onExhaust; alert at the % line. */
export function decideBudget(spent: number, cap: number, onExhaust: OnExhaust, alertPercent: number): BudgetDecision {
  if (cap <= 0) return { mode: "proceed", spentMicroUsd: spent, capMicroUsd: null, alert: false };
  const alert = spent >= cap * (alertPercent / 100);
  if (spent >= cap) return { mode: onExhaust, spentMicroUsd: spent, capMicroUsd: cap, alert: true };
  return { mode: "proceed", spentMicroUsd: spent, capMicroUsd: cap, alert };
}

/**
 * Budget gate. No configured budget → proceed (the free review pool is enforced
 * separately). Over the monthly cap → the configured onExhaust (byo_fallback |
 * queue | block). Returns an `alert` flag when spend crosses the alert %.
 */
export async function checkPlatformBudget(db: DB, t: Tenant): Promise<BudgetDecision> {
  const who = t.orgId ? eq(platformBudgets.orgId, t.orgId) : t.userId ? eq(platformBudgets.userId, t.userId) : null;
  const budget = who ? (await db.select().from(platformBudgets).where(who).limit(1))[0] : undefined;
  if (!budget || budget.monthlyCapMicroUsd <= 0) return { mode: "proceed", spentMicroUsd: 0, capMicroUsd: null, alert: false };
  const spent = await tenantMonthlySpendMicroUsd(db, t);
  return decideBudget(spent, budget.monthlyCapMicroUsd, budget.onExhaust as OnExhaust, budget.alertAtPercent);
}

/** True when a repo's INCLUDED platform-review pool for the month is exhausted
 *  (free = per-repo pool; pro/team = per-seat pool). Beyond it, a review is
 *  overage — dispatch decides whether to proceed (paid) or fall back to BYO. */
export async function reviewPoolExhausted(db: DB, repoId: string, t: Tenant): Promise<boolean> {
  const plan = await planFor(db, { orgId: t.orgId, userId: t.userId });
  const pool = entitlementsFor(plan).platformReviews;
  if (!Number.isFinite(pool)) return false; // unmetered
  // Count this month's native-review runs for the repo (native reviewer standing agent runs).
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns)
    .innerJoin(standingAgents, eq(ciRuns.standingAgentId, standingAgents.id))
    .where(and(eq(ciRuns.repoId, repoId), eq(standingAgents.mode, "review"), eq(standingAgents.isSystem, true), gte(ciRuns.createdAt, monthStartUtc())));
  return (r?.n ?? 0) >= pool;
}

// ── SKU stamping + Stripe reporter ─────────────────────────────────────────

async function runKind(db: DB, standingAgentId: string | null): Promise<"review" | "verify" | "other"> {
  if (!standingAgentId) return "other";
  const sa = (await db.select({ mode: standingAgents.mode }).from(standingAgents).where(eq(standingAgents.id, standingAgentId)).limit(1))[0];
  return sa?.mode === "review" ? "review" : sa?.mode === "verify" ? "verify" : "other";
}

/**
 * The 5-min reporter: stamp a metered SKU on unbilled usage rows and push overage
 * to Stripe. Idempotent — it only touches rows with `stripeReportedAt IS NULL`,
 * and stamps every processed row (including `included` ones as $0) so it never
 * re-scans them. Returns the count reported.
 */
export async function reportUnbilledUsage(db: DB, limit = 500): Promise<number> {
  const rows = await db.select().from(platformUsage)
    .where(and(isNull(platformUsage.stripeReportedAt), isNotNull(platformUsage.runId)))
    .orderBy(platformUsage.createdAt).limit(limit);
  if (!rows.length) return 0;
  // Group by run — one review/verify SKU per RUN, not per gateway request.
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.runId) continue;
    (byRun.get(r.runId) ?? byRun.set(r.runId, []).get(r.runId)!).push(r);
  }
  let reported = 0;
  const now = new Date();
  for (const [runId, group] of byRun) {
    const run = (await db.select({ standingAgentId: ciRuns.standingAgentId }).from(ciRuns).where(eq(ciRuns.id, runId)).limit(1))[0];
    const kind = await runKind(db, run?.standingAgentId ?? null);
    const tenant: Tenant = { orgId: group[0].orgId, userId: group[0].userId };
    let sku: string | null = null;
    if (kind === "review") sku = (await reviewPoolExhausted(db, group[0].repoId ?? "", tenant)) ? "review_overage" : "included";
    else if (kind === "verify") sku = "verify_run"; // credits handled by the plan pool; kept simple here
    // Stamp the SKU + mark reported on every row of the run.
    await db.update(platformUsage).set({ billedSku: sku, stripeReportedAt: now })
      .where(and(eq(platformUsage.runId, runId), isNull(platformUsage.stripeReportedAt)));
    if (sku === "review_overage" || sku === "verify_run") {
      await reportToStripe(sku, tenant).catch(e => log("warn", "stripe_meter_report_failed", { sku, err: (e as Error).message }));
      metrics.inc("clawhub_billing_sku_total", { sku });
      reported++;
    }
  }
  if (reported) log("info", "platform_usage_reported", { count: reported });
  return reported;
}

/** POST a Stripe billing meter event (no-SDK, form-encoded). Guarded by the key
 *  — with no Stripe configured this is a no-op so the pipeline still stamps SKUs. */
async function reportToStripe(sku: string, tenant: Tenant): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  const customer = process.env.STRIPE_METER_CUSTOMER; // resolved per-tenant in a full impl
  if (!key || !customer) return;
  const body = new URLSearchParams({
    event_name: sku === "verify_run" ? "clawhub_verify" : "clawhub_review_overage",
    "payload[stripe_customer_id]": customer,
    "payload[value]": "1",
  });
  const res = await fetch("https://api.stripe.com/v1/billing/meter_events", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`stripe ${res.status}`);
}

/** Start the periodic billing reporter (5-min). Unref'd so it never blocks exit. */
export function startBillingReporter(db: DB): void {
  const tick = () => { reportUnbilledUsage(db).catch(e => log("warn", "billing_reporter_failed", { err: (e as Error).message })); };
  const h = setInterval(tick, Number(process.env.CLAWHUB_BILLING_REPORT_MS ?? 5 * 60_000));
  if (typeof h.unref === "function") h.unref();
}
