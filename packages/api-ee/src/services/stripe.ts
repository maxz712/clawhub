import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "@clawhub/api/db";
import { subscriptions } from "../schema.js";
import { log } from "@clawhub/api/logger";

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
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const customerId = String(obj.customer ?? "");
      const subId = String(obj.id ?? "");
      const status = String(obj.status ?? "active");
      const plan = String(((obj.items as { data?: Array<{ price?: { lookup_key?: string } }> } | undefined)?.data?.[0]?.price?.lookup_key) ?? "team");
      const seats = Number(((obj.items as { data?: Array<{ quantity?: number }> } | undefined)?.data?.[0]?.quantity) ?? 1);
      const periodEnd = obj.current_period_end ? new Date(Number(obj.current_period_end) * 1000) : null;
      const metadata = (obj.metadata as Record<string, unknown> | undefined) ?? {};
      const orgId = typeof metadata.orgId === "string" ? metadata.orgId : null;
      const userId = typeof metadata.userId === "string" ? metadata.userId : null;
      await db.insert(subscriptions).values({
        orgId, userId, plan, status,
        stripeCustomerId: customerId, stripeSubscriptionId: subId,
        seats, currentPeriodEnd: periodEnd,
      }).onConflictDoNothing();
      // If existed, update.
      await db.update(subscriptions).set({
        plan, status, seats, currentPeriodEnd: periodEnd, updatedAt: new Date(),
      }).where(eq(subscriptions.stripeSubscriptionId, subId));
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
    default:
      log("info", "stripe_event_ignored", { type: event.type });
      return { handled: false, note: "ignored" };
  }
}

export async function getOrgSubscription(db: DB, orgId: string) {
  return (await db.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).limit(1))[0] ?? null;
}
