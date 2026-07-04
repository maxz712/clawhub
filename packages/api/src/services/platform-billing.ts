import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ciRuns, platformBudgets, platformUsage, repositories, standingAgents, subscriptions } from "../models/schema.js";
import { planFor, entitlementsFor, grantedPlanForUser, type Plan } from "./entitlements.js";
import { tenantStripeCustomer } from "./stripe.js";
import {
  globalCapExceeded, globalCapMicroUsd, claimReviewOnce, releaseReviewOnce, reserveReviewSlot, refundReviewSlot,
  reserveRepoSlot, releaseRepoSlot, tenantTokensExceeded, claimVerifyOnce, releaseVerifyOnce,
} from "./platform-quota.js";
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
 * D10: the pool is per-TENANT (org XOR user), summed across ALL the tenant's repos,
 * for FREE and PAID alike — free = flat pool (hard-capped at dispatch, so it never
 * actually generates overage), paid = pool × seats. Beyond it a review is overage.
 */
export async function reviewPoolExhausted(db: DB, repoId: string, t: Tenant): Promise<boolean> {
  const plan = await planFor(db, { orgId: t.orgId, userId: t.userId });
  const pool = entitlementsFor(plan).platformReviews;
  if (!Number.isFinite(pool)) return false; // unmetered (enterprise)
  // Count across ALL the tenant's repos (per-tenant scope, not per-repo).
  const who = t.orgId ? eq(repositories.namespaceId, t.orgId) : t.userId ? eq(repositories.namespaceId, t.userId) : null;
  if (!who) return false;
  const repos = await db.select({ id: repositories.id }).from(repositories)
    .where(and(who, eq(repositories.namespaceType, t.orgId ? "org" : "user")));
  if (plan === "free") {
    return (await nativeReviewCount(db, repos.map(r => r.id))) >= pool;
  }
  // Paid: pool × seats.
  const seatsRow = t.orgId
    ? (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.orgId, t.orgId)).limit(1))[0]
    : (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.userId, t.userId!)).limit(1))[0];
  const seats = Math.max(1, seatsRow?.s ?? 1);
  return (await nativeReviewCount(db, repos.map(r => r.id))) >= pool * seats;
}

// ── D10 dispatch authorization (the atomic firewall) ───────────────────────
// The single gate every platform-keyed REVIEW dispatch passes, in order:
//   global $ ceiling → per-commit dedup → tenant $ budget → free token/repo caps →
//   atomic review-count reserve (free = hard cap, paid = tracked-but-soft).
// Returns proceed | byo_fallback | block | queue | skip. On any non-proceed after a
// reserve/claim, it undoes the reservation so a denied dispatch consumes nothing.

export type DispatchMode = "proceed" | "byo_fallback" | "block" | "queue" | "skip";
export interface DispatchAuth { mode: DispatchMode; reason: string; repoAdded?: boolean }

/** Month-to-date GLOBAL platform spend (micro-USD) across ALL tenants, from the
 *  authoritative platform_usage ledger. The DB fallback for the global ceiling so a
 *  Redis outage can't silently disable it (Redis is the fast path; this is the truth). */
export async function globalMonthlySpendMicroUsd(db: DB): Promise<number> {
  const [r] = await db.select({ sum: sql<number>`coalesce(sum(${platformUsage.costMicroUsd}), 0)::bigint` })
    .from(platformUsage).where(gte(platformUsage.createdAt, monthStartUtc()));
  return Number(r?.sum ?? 0);
}

/** The global ceiling check used AT DISPATCH (lower frequency than the gateway): the
 *  fast Redis counter OR the authoritative DB sum — so a Redis blip that zeroes the
 *  counter still trips on the ledger. Fail-open only if BOTH are unavailable. */
export async function globalCapReached(db: DB): Promise<boolean> {
  if (await globalCapExceeded()) return true;                 // Redis fast path
  const cap = globalCapMicroUsd();
  if (cap <= 0) return false;
  try { return (await globalMonthlySpendMicroUsd(db)) >= cap; } catch { return false; }
}

export async function authorizePlatformReview(db: DB, args: {
  tenant: Tenant; plan: Plan; repoId: string; changeId: string; headCommit: string;
}): Promise<DispatchAuth> {
  // 1. Global ceiling — the hard server-side backstop that sits UNDER the OpenRouter
  // prepaid wall (Redis OR the DB ledger, so a Redis outage can't disable it).
  if (await globalCapReached(db)) return { mode: "block", reason: "global_cap" };

  // 2. Per-commit dedup — an already-reviewed (changeId, headCommit) is a no-op, so a
  // republish/force-push of the same head can't re-spend. The claim is HELD only if we
  // proceed; every deny below releases it so a genuine first attempt can retry.
  if (!(await claimReviewOnce(args.changeId, args.headCommit))) return { mode: "skip", reason: "already_reviewed" };
  // Track a repo slot we add so a downstream deny/abort can release it (else a review
  // that never runs permanently consumes a free tenant's reviewMaxRepos).
  let repoAdded = false;
  const deny = async (mode: DispatchMode, reason: string): Promise<DispatchAuth> => {
    await releaseReviewOnce(args.changeId, args.headCommit);
    if (repoAdded) await releaseRepoSlot(args.tenant, args.repoId);
    return { mode, reason };
  };

  // 3. Tenant $ budget (includes an auto-created Loop budget row for agent origins).
  const budget = await checkPlatformBudget(db, args.tenant);
  if (budget.mode === "block") return deny("block", "budget_block");
  if (budget.mode === "queue") return deny("queue", "budget_queue");
  if (budget.mode === "byo_fallback") return deny("byo_fallback", "budget_byo_fallback");

  const ent = entitlementsFor(args.plan);
  // 4. Free-tier input-token ceiling (giant-diff farming guard, beyond per-review 50k).
  if (await tenantTokensExceeded(args.tenant, ent.inputTokensMonthly, ent.inputTokensDaily)) return deny("byo_fallback", "token_cap");
  // 5. Free-tier distinct-repo cap (minted-repo COGS guard).
  const repo = await reserveRepoSlot(args.tenant, args.repoId, ent.reviewMaxRepos);
  repoAdded = repo.added;
  if (!repo.ok) return deny("byo_fallback", "repo_cap");
  // 6. Atomic review-count reserve. Free = HARD monthly + daily cap (byo_fallback
  // beyond); paid = Infinity monthly (soft/metered) but still daily-capped if set.
  const monthlyLimit = args.plan === "free" ? ent.platformReviews : Infinity;
  const res = await reserveReviewSlot(args.tenant, monthlyLimit, ent.reviewDailyCap);
  if (!res.ok) return deny("byo_fallback", `review_${res.over}_cap`);

  return { mode: "proceed", reason: "ok", repoAdded };
}

/** Undo a review reservation + dedup claim + a newly-added repo slot when a dispatch
 *  aborts immediately (the enqueue failed) so a failed dispatch consumes nothing. */
export async function refundPlatformReview(tenant: Tenant, changeId: string, headCommit: string, repoAdded = false, repoId?: string): Promise<void> {
  await refundReviewSlot(tenant);
  await releaseReviewOnce(changeId, headCommit);
  if (repoAdded && repoId) await releaseRepoSlot(tenant, repoId);
}

// ── Loop budget cost-center (D10, M8) ──────────────────────────────────────
// The autonomous Loop is a mandatory SEPARATE metered cost-center: the instant an
// origin='agent' dispatch draws a platform key, ensure the tenant has a budget row
// (conservative default, NEVER unlimited, onExhaust=block) so a runaway Loop is
// bounded. Idempotent + non-destructive: if a human already set a budget, leave it.

const LOOP_BUDGET_DEFAULT_USD = Number(process.env.CLAWHUB_LOOP_BUDGET_DEFAULT_USD ?? 50);

export async function ensureLoopBudget(db: DB, t: Tenant): Promise<void> {
  const who = t.orgId ? eq(platformBudgets.orgId, t.orgId) : t.userId ? eq(platformBudgets.userId, t.userId) : null;
  if (!who) return;
  const existing = (await db.select({ id: platformBudgets.id }).from(platformBudgets).where(who).limit(1))[0];
  if (existing) return; // a human-set budget stands; never override it
  try {
    await db.insert(platformBudgets).values({
      orgId: t.orgId, userId: t.userId,
      monthlyCapMicroUsd: Math.max(1, Math.floor(LOOP_BUDGET_DEFAULT_USD * 1_000_000)),
      onExhaust: "block", alertAtPercent: 80,
    });
    metrics.inc("clawhub_loop_budget_created_total", {});
  } catch { /* concurrent create → the row now exists, which is the goal */ }
}

/** An active PAID subscription (not a trial) — the "payment method required" proxy
 *  for verify credits + overage (checkout implies a payment method on file). A comp'd
 *  allowlist user (admin / CLAWHUB_PAID_EMAILS) counts, so operators + test users aren't
 *  gated on verify without a real Stripe subscription. */
export async function hasActivePaidSubscription(db: DB, t: Tenant): Promise<boolean> {
  if (t.userId && await grantedPlanForUser(db, t.userId)) return true;
  const who = t.orgId ? eq(subscriptions.orgId, t.orgId) : t.userId ? eq(subscriptions.userId, t.userId) : null;
  if (!who) return false;
  const row = (await db.select({ plan: subscriptions.plan }).from(subscriptions).where(and(eq(subscriptions.status, "active"), who)).limit(1))[0];
  return !!row && row.plan !== "free";
}

/** Count platform VERIFY runs (system verifier) this month across the tenant's repos. */
async function verifyRunCount(db: DB, repoIds: string[]): Promise<number> {
  if (!repoIds.length) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(ciRuns)
    .innerJoin(standingAgents, eq(ciRuns.standingAgentId, standingAgents.id))
    .where(and(inArray(ciRuns.repoId, repoIds), eq(standingAgents.mode, "verify"), eq(standingAgents.isSystem, true), gte(ciRuns.createdAt, monthStartUtc())));
  return r?.n ?? 0;
}

/** True when a tenant's included verify-credit pool (credits × seats) is used up. */
export async function verifyPoolExhausted(db: DB, t: Tenant): Promise<boolean> {
  const plan = await planFor(db, { orgId: t.orgId, userId: t.userId });
  const credits = entitlementsFor(plan).verifyCredits;
  if (!Number.isFinite(credits)) return false; // unmetered (enterprise)
  if (credits <= 0) return true;               // free: 0 platform verify
  const who = t.orgId ? eq(repositories.namespaceId, t.orgId) : t.userId ? eq(repositories.namespaceId, t.userId) : null;
  if (!who) return true;
  const repos = await db.select({ id: repositories.id }).from(repositories).where(and(who, eq(repositories.namespaceType, t.orgId ? "org" : "user")));
  const seatsRow = t.orgId
    ? (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.orgId, t.orgId)).limit(1))[0]
    : (await db.select({ s: subscriptions.seats }).from(subscriptions).where(eq(subscriptions.userId, t.userId!)).limit(1))[0];
  const seats = Math.max(1, seatsRow?.s ?? 1);
  return (await verifyRunCount(db, repos.map(r => r.id))) >= credits * seats;
}

/**
 * D10 gate for a platform-keyed VERIFY dispatch. Verify is a metered $2 run, so the
 * bar is higher than review: an ACTIVE PAID subscription (payment method on file),
 * within the verify-credit pool OR paying overage, under the tenant $ budget + the
 * global ceiling. Free (0 verify credits) never dispatches. Ensures the Loop budget.
 */
export async function authorizePlatformVerify(db: DB, args: { tenant: Tenant; plan: Plan; changeId: string; headCommit: string }): Promise<DispatchAuth> {
  if (await globalCapReached(db)) return { mode: "block", reason: "global_cap" };
  // Per-commit dedup — a force-push back to an already-verified head is a no-op (verify
  // is the $2 SKU, so re-spending identical bytes is the costliest churn). Held on
  // proceed; released on every deny + on an enqueue-failure abort (refundPlatformVerify).
  if (!(await claimVerifyOnce(args.changeId, args.headCommit))) return { mode: "skip", reason: "already_verified" };
  const deny = async (mode: DispatchMode, reason: string): Promise<DispatchAuth> => {
    await releaseVerifyOnce(args.changeId, args.headCommit);
    return { mode, reason };
  };
  // Verify is a Loop-class platform-key draw → the mandatory budget row exists first.
  await ensureLoopBudget(db, args.tenant).catch(() => {});
  if (args.plan === "free") return deny("byo_fallback", "no_verify_credits");
  if (!(await hasActivePaidSubscription(db, args.tenant))) return deny("byo_fallback", "payment_method_required");
  const budget = await checkPlatformBudget(db, args.tenant);
  if (budget.mode !== "proceed") return deny(budget.mode, `budget_${budget.mode}`);
  return { mode: "proceed", reason: "ok" };
}

/** Release a verify dedup claim when the dispatch enqueue aborts so a retry can proceed. */
export async function refundPlatformVerify(changeId: string, headCommit: string): Promise<void> {
  await releaseVerifyOnce(changeId, headCommit);
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
    // Stability across retries: if a prior tick already stamped this run's SKU, REUSE it
    // rather than re-deriving (the pool-exhausted state drifts between ticks, which would
    // make a run's included-vs-overage classification nondeterministic → double/lost bill).
    let sku: string | null = group.find(r => r.billedSku)?.billedSku ?? null;
    if (!sku) {
      if (kind === "review") sku = (await reviewPoolExhausted(db, group[0].repoId ?? "", tenant)) ? "review_overage" : "included";
      else if (kind === "verify") sku = (await verifyPoolExhausted(db, tenant)) ? "verify_run" : "included"; // within the credit pool = included
    }

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
