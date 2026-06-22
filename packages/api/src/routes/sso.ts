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
    const [inserted] = await db.insert(ssoProviders).values({
      orgId: c.req.param("orgId"),
      kind: body.kind,
      name: body.name,
      config: body.config ?? {},
      enabled: body.enabled ?? true,
    }).returning();
    return c.json({ provider: { ...inserted, config: redactConfig(inserted.kind, inserted.config as Record<string, unknown>) } }, 201);
  });

  orgs.delete("/:orgId/sso/:id", async c => {
    await requireOrgAdmin(c, c.req.param("orgId"));
    await db.delete(ssoProviders).where(and(eq(ssoProviders.orgId, c.req.param("orgId")), eq(ssoProviders.id, c.req.param("id"))));
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
