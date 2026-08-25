import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, platformBudgets } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { assertPublicHttpHost } from "../services/url-guard.js";
import { acceptInvite, activeTrial, createInvite, listInvites, revokeInvite, startTrial, trialUsed } from "../services/invites.js";
import { getOrgSubscription, handleStripeEvent, verifyStripeSignature, stripeConfigured, createCheckoutSession, createPortalSession } from "../services/stripe.js";
import { captureLead } from "../services/crm.js";
import { entitlementsFor, planFor } from "../services/entitlements.js";
import { checkPlatformBudget, tenantMonthlySpendMicroUsd } from "../services/platform-billing.js";
import { setOrgLlmKey, deleteOrgLlmKey, listOrgLlmKeys, normalizeProvider } from "../services/org-llm-key.js";
import { platformUsage } from "../models/schema.js";

const ADMIN_SET = new Set((process.env.CLAWHUB_ADMIN_EMAILS ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

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
    // trialUsed distinguishes "never trialed" from "trial expired" — the trial
    // is once-per-org (#110), so the UI must not offer a restart after expiry.
    const used = await trialUsed(db, c.req.param("id"));
    return c.json({ subscription: sub, trial, trialUsed: used });
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

  // ── Org-connected LLM keys (N3 / D2 fallback) ─────────────────────────────
  // An org pastes its OWN provider key; the gateway forwards that org's platform
  // runs with it (sealed at rest, never in a container). Presence-only GET; the
  // key is write-only. Set/delete require org ADMIN (it's a billing credential).
  auth.get("/orgs/:id/llm-keys", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireOrgMember(c.req.param("id"), p.userId);
    return c.json({ keys: await listOrgLlmKeys(db, c.req.param("id")) });
  });
  auth.put("/orgs/:id/llm-key", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireOrgAdmin(c.req.param("id"), p.userId);
    const body = await c.req.json().catch(() => ({})) as { provider?: string; key?: string; baseUrl?: string };
    const provider = normalizeProvider(body.provider);
    if (!provider) throw new ValidationError("provider must be one of anthropic | openai (openrouter)");
    if (!body.key || typeof body.key !== "string" || body.key.length < 8) throw new ValidationError("key required");
    const baseUrl = typeof body.baseUrl === "string" && body.baseUrl.trim() ? body.baseUrl.trim() : null;
    // SSRF: this baseUrl is fetched by the LLM gateway — the process holding the
    // platform keys. Reject a non-http(s) or non-public origin at write time so an
    // admin gets an immediate 400 instead of a run that fails opaquely later. (The
    // gateway re-validates + pins at forward time, since DNS can be re-pointed
    // after the row is stored.)
    if (baseUrl) {
      const blocked = await assertPublicHttpHost(baseUrl);
      if (blocked) throw new ValidationError(`baseUrl rejected: ${blocked}`);
    }
    await setOrgLlmKey(db, c.req.param("id"), provider, body.key.trim(), baseUrl);
    return c.json({ ok: true, provider });
  });
  auth.delete("/orgs/:id/llm-key/:provider", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireOrgAdmin(c.req.param("id"), p.userId);
    const provider = normalizeProvider(c.req.param("provider"));
    if (!provider) throw new ValidationError("bad provider");
    await deleteOrgLlmKey(db, c.req.param("id"), provider);
    return c.json({ ok: true });
  });

  // ── Live Stripe (M7): checkout + portal ───────────────────────────────────
  const dashboardBase = (process.env.CLAWHUB_DASHBOARD_URL ?? publicBaseUrl.replace(/\/api.*/, "").replace(/^api\./, "")).replace(/\/+$/, "");
  auth.post("/checkout/session", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    if (!stripeConfigured()) throw new ForbiddenError("billing is not configured", "stripe_not_configured");
    const body = await c.req.json().catch(() => ({})) as { org?: string; seats?: number };
    const orgId = body.org ?? null;
    if (orgId) await requireOrgAdmin(orgId, p.userId);
    const url = await createCheckoutSession(db, { orgId, userId: orgId ? null : p.userId }, {
      seats: body.seats,
      successUrl: `${dashboardBase}/agents/cost?checkout=success`,
      cancelUrl: `${dashboardBase}/pricing?checkout=cancel`,
    });
    return c.json({ url });
  });

  auth.post("/portal/session", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    if (!stripeConfigured()) throw new ForbiddenError("billing is not configured", "stripe_not_configured");
    const body = await c.req.json().catch(() => ({})) as { org?: string };
    const orgId = body.org ?? null;
    if (orgId) await requireOrgAdmin(orgId, p.userId);
    const url = await createPortalSession(db, { orgId, userId: orgId ? null : p.userId }, `${dashboardBase}/agents/cost`);
    return c.json({ url });
  });

  // Dispute resolution (M7): a platform admin issues a CREDIT (or voids a charge)
  // as an adjustment row — negative cost, billedSku='adjustment', pre-marked
  // reported so the meter reporter skips it. Excluded from billable totals.
  auth.post("/admin/credit", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    if (!p.email || !ADMIN_SET.has(p.email.toLowerCase())) throw new ForbiddenError("platform admin only", "admin_only");
    const body = await c.req.json().catch(() => ({})) as { org?: string; user?: string; amountMicroUsd?: number; reason?: string };
    const amount = Math.floor(Number(body.amountMicroUsd ?? 0));
    if (!Number.isFinite(amount) || amount === 0) throw new ValidationError("amountMicroUsd (nonzero) is required");
    // platform_usage.cost_micro_usd is an int4 — a credit beyond its range would
    // crash the insert (a 500, not a clear 400). ~$2147 is the per-adjustment
    // ceiling; split a larger dispute credit into multiple rows.
    if (Math.abs(amount) > 2_147_483_647) throw new ValidationError("amountMicroUsd exceeds the per-adjustment range (±2147483647 = ~$2147)");
    // Enforce org-XOR-user: a credit must land on exactly ONE tenant, else
    // tenantMonthlySpendMicroUsd (org-first) would apply it to the wrong one.
    const orgId = body.org ?? null;
    const userId = orgId ? null : (body.user ?? null);
    if (!orgId && !userId) throw new ValidationError("exactly one of org|user is required");
    await db.insert(platformUsage).values({
      orgId, userId,
      model: "adjustment",
      costMicroUsd: -Math.abs(amount), // a credit reduces the tenant's billable total
      billedSku: "adjustment",
      stripeReportedAt: new Date(), // pre-marked so reportUnbilledUsage never picks it up
      meta: { reason: (body.reason ?? "").slice(0, 500), issuedBy: p.userId },
    });
    return c.json({ ok: true });
  });

  auth.post("/orgs/:id/trial/start", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Only an org admin may start the org's trial — not any authenticated user.
    await requireOrgAdmin(c.req.param("id"), p.userId);
    // Once per org: a restart throws 409 trial_already_used (#110).
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
