import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ssoProviders } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { beginOidcFlow, completeOidcFlow } from "../services/oidc.js";
import { beginSamlFlow, completeSamlFlow } from "../services/saml.js";
import { planFor, requireEntitlement } from "../services/entitlements.js";

export function createSsoRoutes(db: DB): { public: Hono; orgs: Hono } {
  const pub = new Hono();

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
    return c.json({ token, redirectTo });
  });

  pub.post("/saml/acs", async c => {
    const form = await c.req.parseBody();
    const samlResponse = form["SAMLResponse"];
    const relayState = form["RelayState"];
    if (typeof samlResponse !== "string" || typeof relayState !== "string") throw new ValidationError("bad saml post");
    const { token, redirectTo } = await completeSamlFlow(db, samlResponse, relayState);
    // Most IdPs expect an HTML redirect here; we return JSON for SPAs and a tiny HTML shim for IdPs.
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const redirect = redirectTo ?? "/";
      const body = `<!doctype html><html><body>
<script>sessionStorage.setItem('clawhub_token', ${JSON.stringify(token)}); window.location = ${JSON.stringify(redirect)};</script>
Signing you in…</body></html>`;
      return c.html(body);
    }
    return c.json({ token, redirectTo });
  });

  // Per-org management.
  const orgs = new Hono();
  orgs.use("*", authMiddleware);

  orgs.get("/:orgId/sso", async c => {
    const orgId = c.req.param("orgId");
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
    await db.delete(ssoProviders).where(and(eq(ssoProviders.orgId, c.req.param("orgId")), eq(ssoProviders.id, c.req.param("id"))));
    return c.json({ ok: true });
  });

  return { public: pub, orgs };
}

function redactConfig(kind: "oidc" | "saml", cfg: Record<string, unknown>): Record<string, unknown> {
  const c = { ...cfg };
  if (kind === "oidc" && c.clientSecret) c.clientSecret = "***";
  if (kind === "saml" && c.x509cert) c.x509cert = String(c.x509cert).slice(0, 60) + "…";
  return c;
}
