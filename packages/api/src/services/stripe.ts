import { createHmac, timingSafeEqual } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { organizations, stripeEvents, subscriptions, users } from "../models/schema.js";
import { log } from "./logger.js";

// ── No-SDK Stripe API (M7 live billing) ─────────────────────────────────────
// Same convention as the meter-event POST in platform-billing: form-encoded REST,
// no SDK. Every call is guarded by STRIPE_SECRET_KEY — with no key, live billing
// is simply OFF (the routes 503, the reporter no-ops) and the DB-only trial flow
// still works.
export function stripeConfigured(): boolean { return !!process.env.STRIPE_SECRET_KEY; }

interface StripeForm { [k: string]: string | number | undefined }

/** POST form-encoded params to the Stripe API and return the parsed JSON. Throws
 *  on non-2xx. An optional idempotency key makes a retried POST a no-op on Stripe. */
export async function stripePost(path: string, form: StripeForm, idempotencyKey?: string): Promise<Record<string, unknown>> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, String(v));
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`stripe ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export interface StripeTenant { orgId: string | null; userId: string | null }

/** The tenant's Stripe customer id from its (single) subscription row, or null.
 *  ORDER BY updatedAt DESC is defense-in-depth so the read is deterministic even
 *  if a legacy duplicate row predates the unique index. */
export async function tenantStripeCustomer(db: DB, t: StripeTenant): Promise<string | null> {
  const who = t.orgId ? eq(subscriptions.orgId, t.orgId) : t.userId ? eq(subscriptions.userId, t.userId) : null;
  if (!who) return null;
  const row = (await db.select({ c: subscriptions.stripeCustomerId }).from(subscriptions).where(who).orderBy(desc(subscriptions.updatedAt)).limit(1))[0];
  return row?.c ?? null;
}

/**
 * Resolve (or create) the Stripe customer for a tenant. Reuses the customer id
 * from an existing subscription row; else creates a fresh Stripe customer stamped
 * with tenant metadata (so the webhook can attribute the subscription). Best-effort
 * email/name for the Stripe dashboard.
 */
export async function getOrCreateStripeCustomer(db: DB, t: StripeTenant): Promise<string> {
  const existing = await tenantStripeCustomer(db, t);
  if (existing) return existing;
  let email: string | undefined, name: string | undefined;
  if (t.orgId) {
    const o = (await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, t.orgId)).limit(1))[0];
    name = o?.name;
  } else if (t.userId) {
    const u = (await db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, t.userId)).limit(1))[0];
    email = u?.email; name = u?.name ?? undefined;
  }
  // Idempotency-Key keyed on the tenant so a retried/concurrent checkout re-uses
  // the SAME Stripe customer instead of minting a duplicate.
  const idemKey = `cust:${t.orgId ?? t.userId}`;
  const customer = await stripePost("customers", {
    email, name,
    "metadata[orgId]": t.orgId ?? undefined,
    "metadata[userId]": t.userId ?? undefined,
  }, idemKey);
  const customerId = String(customer.id);
  // Persist the customer id IMMEDIATELY (a placeholder row if none exists) so the
  // very next checkout/reporter/portal resolves this customer, never a second one.
  await upsertSubscription(db, { orgId: t.orgId, userId: t.userId, subId: "", customerId, plan: "free", status: "incomplete", seats: 1, periodEnd: null });
  return customerId;
}

/** Create a Checkout session for the Pro plan (subscription mode). Returns the url. */
export async function createCheckoutSession(db: DB, t: StripeTenant, opts: { seats?: number; successUrl: string; cancelUrl: string }): Promise<string> {
  const price = process.env.STRIPE_PRICE_PRO;
  if (!price) throw new Error("stripe_price_not_configured");
  const customer = await getOrCreateStripeCustomer(db, t);
  const form: StripeForm = {
    mode: "subscription", customer,
    "line_items[0][price]": price,
    "line_items[0][quantity]": Math.max(1, opts.seats ?? 1),
    success_url: opts.successUrl, cancel_url: opts.cancelUrl,
    "subscription_data[metadata][orgId]": t.orgId ?? undefined,
    "subscription_data[metadata][userId]": t.userId ?? undefined,
    "metadata[orgId]": t.orgId ?? undefined,
    "metadata[userId]": t.userId ?? undefined,
  };
  // Attach the metered review/verify prices to the same subscription so meter
  // events bill (Stripe Billing Meters key on the customer's metered price).
  let li = 1;
  for (const p of [process.env.STRIPE_PRICE_REVIEW_OVERAGE, process.env.STRIPE_PRICE_VERIFY].filter(Boolean)) {
    form[`line_items[${li}][price]`] = p; li++;
  }
  const session = await stripePost("checkout/sessions", form);
  return String(session.url);
}

/** Create a Billing Portal session for the tenant's customer. Returns the url. */
export async function createPortalSession(db: DB, t: StripeTenant, returnUrl: string): Promise<string> {
  const customer = await tenantStripeCustomer(db, t);
  if (!customer) throw new Error("no_stripe_customer");
  const session = await stripePost("billing_portal/sessions", { customer, return_url: returnUrl });
  return String(session.url);
}

/**
 * Upsert the ONE subscription row for a tenant (org XOR user) — never a duplicate.
 * The partial unique index on (orgId)/(userId) is the backstop; the pre-check +
 * update keeps a single row and preserves the customer id across events. When the
 * event carries no tenant metadata, falls back to keying on the Stripe sub id.
 */
async function upsertSubscription(db: DB, s: { orgId: string | null; userId: string | null; subId: string; customerId: string; plan: string; status: string; seats: number; periodEnd: Date | null }): Promise<void> {
  const set = { plan: s.plan, status: s.status, seats: s.seats, currentPeriodEnd: s.periodEnd, stripeCustomerId: s.customerId || undefined, stripeSubscriptionId: s.subId || undefined, updatedAt: new Date() };
  const tenantWhere = s.orgId ? eq(subscriptions.orgId, s.orgId) : s.userId ? eq(subscriptions.userId, s.userId) : null;
  if (tenantWhere) {
    const existing = (await db.select({ id: subscriptions.id }).from(subscriptions).where(tenantWhere).limit(1))[0];
    if (existing) { await db.update(subscriptions).set(set).where(eq(subscriptions.id, existing.id)); return; }
    try {
      await db.insert(subscriptions).values({ orgId: s.orgId, userId: s.userId, plan: s.plan, status: s.status, seats: s.seats, currentPeriodEnd: s.periodEnd, stripeCustomerId: s.customerId || null, stripeSubscriptionId: s.subId || null });
    } catch (e) {
      // Lost the unique-index race with a concurrent event — update the winner.
      if ((e as { code?: string }).code === "23505") { await db.update(subscriptions).set(set).where(tenantWhere); return; }
      throw e;
    }
    return;
  }
  // No tenant metadata: key on the Stripe subscription id.
  if (s.subId) {
    const existing = (await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.stripeSubscriptionId, s.subId)).limit(1))[0];
    if (existing) await db.update(subscriptions).set(set).where(eq(subscriptions.id, existing.id));
    else await db.insert(subscriptions).values({ orgId: null, userId: null, plan: s.plan, status: s.status, seats: s.seats, currentPeriodEnd: s.periodEnd, stripeCustomerId: s.customerId || null, stripeSubscriptionId: s.subId });
  }
}

/**
 * Verify a Stripe webhook signature. The `Stripe-Signature` header contains
 *   t=TIMESTAMP,v1=HEX,v1=HEX...
 * We sign `TIMESTAMP.BODY` with the endpoint secret and compare constant-time.
 */
export function verifyStripeSignature(signatureHeader: string, body: string): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!secret) return false;
  const parts = Object.fromEntries(signatureHeader.split(",").map(p => { const [k, v] = p.split("="); return [k, v]; }));
  const ts = parts.t;
  const sigs = signatureHeader.split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  if (!ts || sigs.length === 0) return false;
  // Reject stale signatures (replay): the signed timestamp must be within a
  // 5-minute tolerance of now, matching Stripe's default verification window.
  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds) || Math.abs(Date.now() / 1000 - tsSeconds) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  for (const sig of sigs) {
    try {
      if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export async function handleStripeEvent(db: DB, event: StripeEvent): Promise<{ handled: boolean; note?: string }> {
  const obj = event.data.object;
  // Idempotency: Stripe redelivers on any non-2xx/timeout. Record the event id and
  // short-circuit a redelivery so its subscription side effects never replay.
  if (event.id) {
    const claimed = await db.insert(stripeEvents).values({ eventId: event.id, type: event.type }).onConflictDoNothing().returning({ id: stripeEvents.eventId });
    if (!claimed.length) return { handled: true, note: "duplicate" };
  }
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const customerId = String(obj.customer ?? "");
      const subId = String(obj.id ?? "");
      const status = String(obj.status ?? "active");
      const plan = String(((obj.items as { data?: Array<{ price?: { lookup_key?: string } }> } | undefined)?.data?.[0]?.price?.lookup_key) ?? "pro");
      const seats = Number(((obj.items as { data?: Array<{ quantity?: number }> } | undefined)?.data?.[0]?.quantity) ?? 1);
      const periodEnd = obj.current_period_end ? new Date(Number(obj.current_period_end) * 1000) : null;
      const metadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};
      const orgId = typeof metadata.orgId === "string" && metadata.orgId ? metadata.orgId : null;
      const userId = typeof metadata.userId === "string" && metadata.userId ? metadata.userId : null;
      await upsertSubscription(db, { orgId, userId, subId, customerId, plan, status, seats, periodEnd });
      return { handled: true };
    }
    case "customer.subscription.deleted": {
      await db.update(subscriptions).set({ status: "canceled", updatedAt: new Date() }).where(eq(subscriptions.stripeSubscriptionId, String(obj.id ?? "")));
      return { handled: true };
    }
    case "invoice.payment_failed": {
      await db.update(subscriptions).set({ status: "past_due", updatedAt: new Date() }).where(eq(subscriptions.stripeCustomerId, String(obj.customer ?? "")));
      return { handled: true };
    }
    case "checkout.session.completed": {
      // Belt-and-suspenders: link the customer + tenant eagerly (subscription.created
      // also fires, but ordering varies). The tenant-keyed upsert collapses both
      // events into ONE row, so the customer id is resolvable for the reporter +
      // portal without ever minting a duplicate.
      const customerId = String(obj.customer ?? "");
      const subId = String(obj.subscription ?? "");
      const md = (obj.metadata as Record<string, unknown> | undefined) ?? {};
      const orgId = typeof md.orgId === "string" && md.orgId ? md.orgId : null;
      const userId = typeof md.userId === "string" && md.userId ? md.userId : null;
      if (customerId && (orgId || userId)) {
        await upsertSubscription(db, { orgId, userId, subId, customerId, plan: "pro", status: "active", seats: 1, periodEnd: null });
      }
      return { handled: true };
    }
    default:
      log("info", "stripe_event_ignored", { type: event.type });
      return { handled: false, note: "ignored" };
  }
}

export async function getOrgSubscription(db: DB, orgId: string) {
  return (await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).limit(1))[0] ?? null;
}
