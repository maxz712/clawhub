import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, platformBudgets, platformUsage, repositories, standingAgents, subscriptions } from "../models/schema.js";
import { planFor, entitlementsFor } from "./entitlements.js";
import { tenantStripeCustomer } from "./stripe.js";
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

/** Count native-reviewer (system, review-mode) runs this month across the given repos. */
async function nativeReviewCount(db: DB, repoIds: string[]): Promise<number> {
  if (!repoIds.length) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns)
    .innerJoin(standingAgents, eq(ciRuns.standingAgentId, standingAgents.id))
    .where(and(inArray(ciRuns.repoId, repoIds), eq(standingAgents.mode, "review"), eq(standingAgents.isSystem, true), gte(ciRuns.createdAt, monthStartUtc())));
  return r?.n ?? 0;
}

/**
 * True when a tenant's INCLUDED platform-review pool for the month is exhausted.
 * FREE is a per-REPO pool (50/repo); a PAID plan is a per-TENANT pool scaled by
 * seats (500 × seats, counted across ALL the tenant's repos). Beyond it a review
 * is overage — dispatch decides whether to proceed (paid) or fall back to BYO.
 */
export async function reviewPoolExhausted(db: DB, repoId: string, t: Tenant): Promise<boolean> {
  const plan = await planFor(db, { orgId: t.orgId, userId: t.userId });
  const pool = entitlementsFor(plan).platformReviews;
  if (!Number.isFinite(pool)) return false; // unmetered (enterprise)
  if (plan === "free") {
    return (await nativeReviewCount(db, [repoId])) >= pool;
  }
  // Paid: count across the tenant's repos, pool × seats.
  const who = t.orgId ? eq(repositories.namespaceId, t.orgId) : t.userId ? eq(repositories.namespaceId, t.userId) : null;
  if (!who) return false;
  const repos = await db.select({ id: repositories.id }).from(repositories)
    .where(and(who, eq(repositories.namespaceType, t.orgId ? "org" : "user")));
  const seatsRow = t.orgId
    ? (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.orgId, t.orgId)).limit(1))[0]
    : (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.userId, t.userId!)).limit(1))[0];
  const seats = Math.max(1, seatsRow?.s ?? 1);
  return (await nativeReviewCount(db, repos.map(r => r.id))) >= pool * seats;
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

    // Non-billable (included / other): stamp the SKU AND mark reported now —
    // nothing to send, and we never want to re-scan it.
    if (sku !== "review_overage" && sku !== "verify_run") {
      await db.update(platformUsage).set({ billedSku: sku, stripeReportedAt: now })
        .where(and(eq(platformUsage.runId, runId), isNull(platformUsage.stripeReportedAt)));
      continue;
    }

    // Billable: stamp the SKU but leave stripeReportedAt NULL until the Stripe POST
    // CONFIRMS. A deterministic identifier (runId:sku) lets Stripe dedupe, so a
    // retry (next tick, since the rows stay unreported on failure) can never
    // double-bill. This closes the "marked reported before the POST → lost charge"
    // hole AND the double-bill-on-retry/race hole together.
    await db.update(platformUsage).set({ billedSku: sku })
      .where(and(eq(platformUsage.runId, runId), isNull(platformUsage.stripeReportedAt)));
    try {
      await reportToStripe(db, sku, tenant, `${runId}:${sku}`);
      await db.update(platformUsage).set({ stripeReportedAt: now })
        .where(and(eq(platformUsage.runId, runId), isNull(platformUsage.stripeReportedAt)));
      metrics.inc("clawhub_billing_sku_total", { sku });
      reported++;
    } catch (e) {
      // Leave stripeReportedAt NULL → the next tick re-attempts (Stripe dedupes on
      // the identifier). No charge is lost; none is double-counted.
      log("warn", "stripe_meter_report_failed", { sku, runId, err: (e as Error).message });
    }
  }
  if (reported) log("info", "platform_usage_reported", { count: reported });
  return reported;
}

/** POST a Stripe billing meter event (no-SDK, form-encoded) for the RESOLVED
 *  per-tenant customer, with a deterministic `identifier` for Stripe-side dedup.
 *  NO global-customer fallback — an unresolvable tenant is a no-op, never
 *  cross-billed to some other customer. Returns false (no-op) when Stripe/customer
 *  is absent so the caller does not mark the row reported. Throws only on a real
 *  Stripe error (→ the caller leaves the row for retry). */
async function reportToStripe(db: DB, sku: string, tenant: Tenant, identifier: string): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return; // Stripe not configured on this instance → no-op (row is marked reported).
  const customer = await tenantStripeCustomer(db, tenant);
  // Stripe IS configured but the tenant's customer isn't linked yet (webhook lag)
  // — THROW so the caller leaves the row for a later tick rather than losing the
  // charge. Never a global fallback (no cross-tenant mis-billing).
  if (!customer) throw new Error("no_customer_yet");
  const body = new URLSearchParams({
    event_name: sku === "verify_run" ? "clawhub_verify" : "clawhub_review_overage",
    identifier, // Stripe dedupes meter events on this — retries can't double-bill
    "payload[stripe_customer_id]": String(customer),
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
