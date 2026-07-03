import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, platformBudgets } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { acceptInvite, activeTrial, createInvite, listInvites, revokeInvite, startTrial } from "../services/invites.js";
import { getOrgSubscription, handleStripeEvent, verifyStripeSignature } from "../services/stripe.js";
import { captureLead } from "../services/crm.js";
import { entitlementsFor, planFor } from "../services/entitlements.js";
import { checkPlatformBudget, tenantMonthlySpendMicroUsd } from "../services/platform-billing.js";

export function createBillingRoutes(db: DB, publicBaseUrl: string): { pub: Hono; auth: Hono } {
  // Org billing/membership management is org-private: without these gates any
  // authenticated user could invite themselves as admin to ANY org (takeover),
  // enumerate another org's invites, or start its trial. Mirrors routes/sso.ts:
  // a non-member reads as 404 (no org existence leak); a non-admin gets 403.
  async function requireOrgMember(orgId: string, userId: string): Promise<void> {
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1))[0];
    if (!m) throw new NotFoundError("org");
  }
  async function requireOrgAdmin(orgId: string, userId: string): Promise<void> {
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1))[0];
    if (!m) throw new NotFoundError("org");
    if (m.role !== "admin") throw new ForbiddenError("org admin required");
  }

  const pub = new Hono();

  // Stripe webhook — path must match the endpoint configured in the Stripe dashboard.
  pub.post("/stripe/webhook", async c => {
    const sig = c.req.header("stripe-signature") ?? "";
    const body = await c.req.text();
    if (!verifyStripeSignature(sig, body)) return c.json({ error: "bad_signature" }, 401);
    const event = JSON.parse(body);
    const result = await handleStripeEvent(db, event);
    return c.json(result);
  });

  // Unauthenticated lead capture ("Contact sales" forms).
  pub.post("/leads", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; name?: string; company?: string; note?: string; source?: string };
    if (!body.email) throw new ValidationError("email required");
    const id = await captureLead(db, { email: body.email, name: body.name, company: body.company, note: body.note, source: body.source ?? "web" });
    return c.json({ ok: true, id });
  });

  const auth = new Hono();
  auth.use("*", authMiddleware);

  auth.get("/orgs/:id/subscription", async c => {
    const sub = await getOrgSubscription(db, c.req.param("id"));
    const trial = await activeTrial(db, c.req.param("id"));
    return c.json({ subscription: sub, trial });
  });

  // What this org's plan grants — drives the dashboard's upgrade prompts (#8).
  auth.get("/orgs/:id/entitlements", async c => {
    const plan = await planFor(db, { orgId: c.req.param("id") });
    return c.json({ plan, features: entitlementsFor(plan) });
  });

  // ── Platform-spend (M7): month-to-date usage + the tenant budget ──────────
  // The caller's OWN platform usage/budget (userId from the token), or an org's
  // (members only). Backs the billing dashboard's spend meter.
  auth.get("/usage", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const orgId = c.req.query("org") ?? null;
    if (orgId) await requireOrgMember(orgId, p.userId);
    const tenant = orgId ? { orgId, userId: null } : { orgId: null, userId: p.userId };
    const spentMicroUsd = await tenantMonthlySpendMicroUsd(db, tenant);
    const plan = await planFor(db, { orgId, userId: orgId ? null : p.userId });
    const budget = await checkPlatformBudget(db, tenant);
    return c.json({ plan, entitlements: entitlementsFor(plan), spentMicroUsd, budget: { capMicroUsd: budget.capMicroUsd, mode: budget.mode, alert: budget.alert } });
  });

  auth.put("/budget", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { org?: string; monthlyCapMicroUsd?: number; onExhaust?: string; alertAtPercent?: number };
    const orgId = body.org ?? null;
    if (orgId) await requireOrgMember(orgId, p.userId);
    const onExhaust = ["byo_fallback", "queue", "block"].includes(body.onExhaust ?? "") ? body.onExhaust! : "byo_fallback";
    const cap = Math.max(0, Math.floor(Number(body.monthlyCapMicroUsd ?? 0)));
    const alertAtPercent = Math.min(100, Math.max(1, Math.floor(Number(body.alertAtPercent ?? 80))));
    const who = orgId ? eq(platformBudgets.orgId, orgId) : eq(platformBudgets.userId, p.userId);
    const existing = (await db.select().from(platformBudgets).where(who).limit(1))[0];
    if (existing) {
      await db.update(platformBudgets).set({ monthlyCapMicroUsd: cap, onExhaust, alertAtPercent, updatedAt: new Date() }).where(eq(platformBudgets.id, existing.id));
    } else {
      await db.insert(platformBudgets).values({ orgId, userId: orgId ? null : p.userId, monthlyCapMicroUsd: cap, onExhaust, alertAtPercent });
    }
    return c.json({ ok: true });
  });

  auth.post("/orgs/:id/trial/start", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Only an org admin may start the org's trial — not any authenticated user.
    await requireOrgAdmin(c.req.param("id"), p.userId);
    await startTrial(db, c.req.param("id"));
    return c.json({ ok: true });
  });

  auth.get("/orgs/:id/invites", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Invites are org-private — require membership to enumerate them.
    await requireOrgMember(c.req.param("id"), p.userId);
    return c.json({ invites: await listInvites(db, c.req.param("id")) });
  });

  auth.post("/orgs/:id/invites", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Require org admin — otherwise any user could invite themselves as admin (org takeover).
    await requireOrgAdmin(c.req.param("id"), p.userId);
    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: "admin" | "member" };
    if (!body.email) throw new ValidationError("email required");
    const r = await createInvite(db, { orgId: c.req.param("id"), email: body.email, role: body.role, invitedBy: p.userId, publicBaseUrl });
    return c.json({ invite: r }, 201);
  });

  auth.delete("/orgs/:id/invites/:inviteId", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Only an org admin may revoke an invite.
    await requireOrgAdmin(c.req.param("id"), p.userId);
    await revokeInvite(db, c.req.param("id"), c.req.param("inviteId"));
    return c.json({ ok: true });
  });

  auth.post("/invites/accept", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { token?: string };
    if (!body.token) throw new ValidationError("token required");
    const res = await acceptInvite(db, body.token, p.userId);
    if (!res) return c.json({ ok: false, error: "invalid_or_email_mismatch" }, 400);
    return c.json({ ok: true, ...res });
  });

  return { pub, auth };
}
