import { Hono } from "hono";
import type { Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, ssoProviders } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { beginOidcFlow, completeOidcFlow } from "../services/oidc.js";
import { beginSamlFlow, completeSamlFlow } from "../services/saml.js";
import { planFor, requireEntitlement } from "../services/entitlements.js";
import { testConnection, validateProviderConfig } from "../services/sso-validate.js";
import { createScimToken, listScimTokens, revokeScimToken } from "../services/scim-tokens.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

export function createSsoRoutes(db: DB): { public: Hono; orgs: Hono } {
  const pub = new Hono();

  // The dashboard origin we hand the session JWT to. Same resolution chain as
  // routes/oauth.ts so SSO and consumer-OAuth land on the identical contract.
  const dashboardUrl = (process.env.CLAWHUB_DASHBOARD_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/+$/, "");

  // Build the OAuth-landing URL the dashboard's /login/oauth page expects: the
  // JWT rides in the URL FRAGMENT (never sent to a server or written to logs);
  // an optional post-login destination rides as a `next` query param. The
  // landing page ALSO re-sanitizes `next` (defense in depth), so a hostile
  // `redirect_to` on the public /sso/start cannot bounce the freshly-signed-in
  // user off-site.
  function landingUrl(token: string, redirectTo: string | null): string {
    const safe = safeRelativePath(redirectTo);
    const next = safe ? `?next=${encodeURIComponent(safe)}` : "";
    return `${dashboardUrl}/login/oauth${next}#token=${encodeURIComponent(token)}`;
  }

  // Public start + callback handlers.
  pub.get("/start/:providerId", async c => {
    const providerId = c.req.param("providerId");
    const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, providerId)).limit(1))[0];
    if (!provider) throw new NotFoundError("sso provider");
    // A disabled provider must not start a login. The flow services also guard
    // on `enabled`, but reject here first so a disabled provider reads as gone
    // (404) at the public surface rather than leaking config-state via a 400.
    if (!provider.enabled) throw new NotFoundError("sso provider");
    const redirectTo = c.req.query("redirect_to") ?? undefined;
    if (provider.kind === "oidc") {
      const { authorizeUrl } = await beginOidcFlow(db, providerId, redirectTo);
      return c.redirect(authorizeUrl);
    }
    const { redirectUrl } = await beginSamlFlow(db, providerId, redirectTo);
    return c.redirect(redirectUrl);
  });

  pub.get("/oidc/callback", async c => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) throw new ValidationError("missing state or code");
    const { token, redirectTo } = await completeOidcFlow(db, state, code);
    // The IdP redirected the BROWSER here, so this must hand off to a page that
    // signs the user in — not return a raw JSON token blob the browser renders
    // as text (the prior behavior left the employee stranded on a JSON dump,
    // never signed in). 302 to the dashboard's OAuth landing page with the JWT
    // in the fragment, exactly like the consumer-OAuth flow.
    return c.redirect(landingUrl(token, redirectTo), 302);
  });

  pub.post("/saml/acs", async c => {
    const form = await c.req.parseBody();
    const samlResponse = form["SAMLResponse"];
    const relayState = form["RelayState"];
    if (typeof samlResponse !== "string" || typeof relayState !== "string") throw new ValidationError("bad saml post");
    const { token, redirectTo } = await completeSamlFlow(db, samlResponse, relayState);
    // The SAML ACS is a browser POST from the IdP, so it must drive the browser
    // to the SAME OAuth-landing contract the app actually reads (localStorage
    // via /login/oauth) — the old shim wrote sessionStorage['clawhub_token'],
    // a key the app never reads, so the user appeared signed-out. We hand off
    // via a tiny HTML page because some IdPs/CSPs disallow a 302 off an ACS
    // POST; the page navigates to the landing URL (token in the fragment).
    const target = landingUrl(token, redirectTo);
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const body = `<!doctype html><html><body>
<script>window.location = ${JSON.stringify(target)};</script>
Signing you in…</body></html>`;
      return c.html(body);
    }
    return c.redirect(target, 302);
  });

  // Per-org management.
  const orgs = new Hono();
  orgs.use("*", authMiddleware);

  // An org's SSO/IdP configuration is org-private and security-sensitive: only
  // members may read it, and only admins may create/delete providers. Without
  // this gate any authenticated caller could read, configure, or tear down
  // ANOTHER org's identity provider. Mirrors routes/orgs.ts's membership/admin
  // gate (orgMembers by (orgId, userId)). A non-member reads as 404 (no org
  // existence leak); a non-admin member gets 403 on writes.
  async function requireOrgAdmin(c: Context, orgId: string): Promise<void> {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
    if (!m) throw new NotFoundError("org");
    if (m.role !== "admin") throw new ForbiddenError("only org admins can manage sso");
  }

  orgs.get("/:orgId/sso", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const orgId = c.req.param("orgId");
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, p.userId))).limit(1))[0];
    if (!m) throw new NotFoundError("org");
    const rows = await db.select().from(ssoProviders).where(eq(ssoProviders.orgId, orgId));
    // Redact secrets before returning.
    return c.json({
      providers: rows.map(r => ({
        ...r,
        config: redactConfig(r.kind, r.config as Record<string, unknown>),
      })),
    });
  });

  orgs.post("/:orgId/sso", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    // Authorize BEFORE the entitlement check so a non-admin can't probe an org's
    // plan or alter its IdP config.
    await requireOrgAdmin(c, c.req.param("orgId"));
    const body = await c.req.json().catch(() => ({})) as { name?: string; kind?: "oidc" | "saml"; config?: Record<string, unknown>; enabled?: boolean };
    if (!body.name || !body.kind) throw new ValidationError("name and kind required");
    if (!["oidc", "saml"].includes(body.kind)) throw new ValidationError("bad kind");
    // SSO/SAML is a paid (Team+) feature (#8). Gate configuring a new IdP;
    // public sign-in flows stay open for already-configured providers.
    requireEntitlement(await planFor(db, { orgId: c.req.param("orgId") }), "sso");
    // Validate the config so a typo'd issuer/cert is caught at create time, the
    // same shape the PATCH (edit) path enforces.
    validateProviderConfig(body.kind, body.config ?? {});
    const [inserted] = await db.insert(ssoProviders).values({
      orgId: c.req.param("orgId"),
      kind: body.kind,
      name: body.name,
      config: body.config ?? {},
      enabled: body.enabled ?? true,
    }).returning();
    await getAuditLog(db).record({
      actorKind: "human",
      actorId: p.userId,
      action: "sso.provider.created",
      category: "admin",
      metadata: { orgId: c.req.param("orgId"), providerId: inserted.id, kind: inserted.kind, name: inserted.name },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ provider: { ...inserted, config: redactConfig(inserted.kind, inserted.config as Record<string, unknown>) } }, 201);
  });

  // Test an existing provider's connection: for OIDC, fetch the issuer's
  // discovery document and validate the required endpoints; for SAML, parse the
  // configured IdP cert. Network/parse failures come back as { ok:false, detail }
  // (a 200) — never a 500 — so the admin sees exactly what is wrong. Org-admin
  // gated because the provider config is org-private + security-sensitive.
  orgs.post("/:orgId/sso/:id/test", async c => {
    await requireOrgAdmin(c, c.req.param("orgId"));
    // SSO is a paid (Team+) feature — gate the probe like create/edit so a
    // lapsed org can't exercise the paid surface (and so the server-side issuer
    // fetch isn't reachable without an active entitlement).
    requireEntitlement(await planFor(db, { orgId: c.req.param("orgId") }), "sso");
    const provider = (await db.select().from(ssoProviders)
      .where(and(eq(ssoProviders.orgId, c.req.param("orgId")), eq(ssoProviders.id, c.req.param("id")))).limit(1))[0];
    if (!provider) throw new NotFoundError("sso provider");
    const result = await testConnection(provider.kind, provider.config as Record<string, unknown>);
    return c.json(result);
  });

  // Edit a provider's mutable config (name, config fields, enabled). Validates
  // config the same way create does. Org-admin gated.
  orgs.patch("/:orgId/sso/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireOrgAdmin(c, c.req.param("orgId"));
    // Editing/re-enabling a provider IS configuring an IdP — gate it on the same
    // Team+ entitlement the create path enforces, so the paid feature can't be
    // kept alive (or re-enabled) via PATCH after an org drops to free.
    requireEntitlement(await planFor(db, { orgId: c.req.param("orgId") }), "sso");
    const orgId = c.req.param("orgId");
    const id = c.req.param("id");
    const existing = (await db.select().from(ssoProviders)
      .where(and(eq(ssoProviders.orgId, orgId), eq(ssoProviders.id, id))).limit(1))[0];
    if (!existing) throw new NotFoundError("sso provider");
    const body = await c.req.json().catch(() => ({})) as { name?: string; config?: Record<string, unknown>; enabled?: boolean };

    const update: { name?: string; config?: Record<string, unknown>; enabled?: boolean } = {};
    if (body.name !== undefined) {
      if (!body.name) throw new ValidationError("name cannot be empty");
      update.name = body.name;
    }
    if (body.config !== undefined) {
      // Kind is immutable on edit (it dictates which config shape is valid and
      // recreating is cheap). The GET redacts secrets, so the dashboard cannot
      // round-trip the real clientSecret/x509cert — merge an empty or redacted
      // secret field from the EXISTING config so an edit never wipes it.
      const merged = mergeProviderConfig(existing.kind, existing.config as Record<string, unknown>, body.config);
      validateProviderConfig(existing.kind, merged);
      update.config = merged;
    }
    if (body.enabled !== undefined) update.enabled = body.enabled;
    if (Object.keys(update).length === 0) throw new ValidationError("no mutable fields supplied");

    const [updated] = await db.update(ssoProviders).set(update)
      .where(and(eq(ssoProviders.orgId, orgId), eq(ssoProviders.id, id))).returning();
    await getAuditLog(db).record({
      actorKind: "human",
      actorId: p.userId,
      action: body.enabled !== undefined && Object.keys(update).length === 1
        ? (body.enabled ? "sso.provider.enabled" : "sso.provider.disabled")
        : "sso.provider.updated",
      category: "admin",
      metadata: { orgId, providerId: id, fields: Object.keys(update) },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ provider: { ...updated, config: redactConfig(updated.kind, updated.config as Record<string, unknown>) } });
  });

  orgs.delete("/:orgId/sso/:id", async c => {
    const p = c.get("tokenPayload");
    await requireOrgAdmin(c, c.req.param("orgId"));
    await db.delete(ssoProviders).where(and(eq(ssoProviders.orgId, c.req.param("orgId")), eq(ssoProviders.id, c.req.param("id"))));
    await getAuditLog(db).record({
      actorKind: "human",
      actorId: p.kind === "user" ? p.userId : null,
      action: "sso.provider.deleted",
      category: "admin",
      metadata: { orgId: c.req.param("orgId"), providerId: c.req.param("id") },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  // ---- SCIM provisioning credentials (#133) -------------------------------
  // The IdP's provisioning token, scoped to ONE org. Before this the SCIM
  // surface authenticated against a single instance-wide env var, so every
  // customer's Okta held the same credential and could enumerate, rename and
  // delete any other customer's users. Same org-admin + Team+ gate as the
  // IdP config these tokens sit beside.

  orgs.get("/:orgId/scim/tokens", async c => {
    await requireOrgAdmin(c, c.req.param("orgId"));
    return c.json({ tokens: await listScimTokens(db, c.req.param("orgId")) });
  });

  orgs.post("/:orgId/scim/tokens", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    await requireOrgAdmin(c, c.req.param("orgId"));
    requireEntitlement(await planFor(db, { orgId: c.req.param("orgId") }), "sso");
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    const name = (body.name ?? "").trim();
    if (!name) throw new ValidationError("name required");
    if (name.length > 120) throw new ValidationError("name too long");
    const { token, summary } = await createScimToken(db, c.req.param("orgId"), name, p.userId);
    await getAuditLog(db).record({
      actorKind: "human",
      actorId: p.userId,
      action: "scim.token.created",
      category: "admin",
      metadata: { orgId: c.req.param("orgId"), tokenId: summary.id, name },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    // The raw value is shown ONCE — only its sha256 is stored.
    return c.json({ token, scimToken: summary }, 201);
  });

  orgs.delete("/:orgId/scim/tokens/:id", async c => {
    const p = c.get("tokenPayload");
    await requireOrgAdmin(c, c.req.param("orgId"));
    if (!(await revokeScimToken(db, c.req.param("orgId"), c.req.param("id")))) throw new NotFoundError("scim token");
    await getAuditLog(db).record({
      actorKind: "human",
      actorId: p.kind === "user" ? p.userId : null,
      action: "scim.token.revoked",
      category: "admin",
      metadata: { orgId: c.req.param("orgId"), tokenId: c.req.param("id") },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  return { public: pub, orgs };
}

// An app-relative redirect target, or null if the input is not safe. Guards the
// post-login `next` against open redirects: it must be a single-leading-slash
// path with NO protocol-relative "//", NO backslash (browsers normalize "\" to
// "/", so "/\evil.com" → "//evil.com" → off-site), and no control characters
// (URL parsers strip tab/newline, another smuggling vector).
export function safeRelativePath(s: string | null | undefined): string | null {
  if (!s) return null;
  if (s.includes("\\")) return null;                  // backslash → browser normalizes to "/"
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;    // control chars (tab/newline smuggling)
  if (!/^\/[^/]/.test(s)) return null;                 // single leading slash, not "//"
  return s;
}

function redactConfig(kind: "oidc" | "saml", cfg: Record<string, unknown>): Record<string, unknown> {
  const c = { ...cfg };
  if (kind === "oidc" && c.clientSecret) c.clientSecret = "***";
  if (kind === "saml" && c.x509cert) c.x509cert = String(c.x509cert).slice(0, 60) + "…";
  return c;
}

// Secret fields, by kind, that `redactConfig` masks before returning a provider.
const SECRET_FIELDS: Record<"oidc" | "saml", string> = { oidc: "clientSecret", saml: "x509cert" };

// True if a value is the redaction placeholder the GET surface returns (so a
// client editing a provider it just fetched would echo it back unchanged).
function isRedactedSecret(v: unknown): boolean {
  return v === "***" || (typeof v === "string" && v.endsWith("…"));
}

// Merge an incoming edit config over the existing one, preserving the secret
// field when the incoming value is empty/missing or the redaction placeholder.
// The dashboard never sees the real secret (it's redacted on read), so blanking
// the field on an edit must mean "keep the current secret", not "wipe it".
export function mergeProviderConfig(
  kind: "oidc" | "saml",
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...incoming };
  const field = SECRET_FIELDS[kind];
  const next = merged[field];
  if (next === undefined || next === null || next === "" || isRedactedSecret(next)) {
    if (existing[field] !== undefined) merged[field] = existing[field];
    else delete merged[field];
  }
  return merged;
}
