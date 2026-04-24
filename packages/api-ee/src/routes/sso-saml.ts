import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "@clawhub/api/db";
import { ssoProviders } from "@clawhub/api/schema";
import { authMiddleware } from "@clawhub/api/middleware/auth";
import { AuthError, NotFoundError, ValidationError } from "@clawhub/api/errors";
import { beginSamlFlow, completeSamlFlow } from "../services/saml.js";
import { buildSpMetadata } from "../services/saml-metadata.js";

// EE-only SAML routes. Mounted by registerEeRoutes.
export function createSamlRoutes(db: DB, publicBaseUrl: string): { public: Hono; orgs: Hono; saml: Hono } {
  const pub = new Hono();

  // SAML start endpoint — the EE counterpart to /sso/start/:providerId.
  // The dashboard redirects here for saml-kind providers.
  pub.get("/saml/start/:providerId", async c => {
    const providerId = c.req.param("providerId");
    const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, providerId)).limit(1))[0];
    if (!provider) throw new NotFoundError("sso provider");
    if (provider.kind !== "saml") throw new ValidationError("provider_not_saml");
    const redirectTo = c.req.query("redirect_to") ?? undefined;
    const { redirectUrl } = await beginSamlFlow(db, providerId, redirectTo);
    return c.redirect(redirectUrl);
  });

  pub.post("/saml/acs", async c => {
    const form = await c.req.parseBody();
    const samlResponse = form["SAMLResponse"];
    const relayState = form["RelayState"];
    if (typeof samlResponse !== "string" || typeof relayState !== "string") throw new ValidationError("bad saml post");
    const { token, redirectTo } = await completeSamlFlow(db, samlResponse, relayState);
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const redirect = redirectTo ?? "/";
      const body = `<!doctype html><html><body>
<script>sessionStorage.setItem('clawhub_token', ${JSON.stringify(token)}); window.location = ${JSON.stringify(redirect)};</script>
Signing you in…</body></html>`;
      return c.html(body);
    }
    return c.json({ token, redirectTo });
  });

  // Per-org SAML provider creation — EE-only; core's POST /:orgId/sso rejects saml kind.
  const orgs = new Hono();
  orgs.use("*", authMiddleware);

  orgs.post("/:orgId/sso/saml", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { name?: string; config?: Record<string, unknown>; enabled?: boolean };
    if (!body.name) throw new ValidationError("name required");
    const [inserted] = await db.insert(ssoProviders).values({
      orgId: c.req.param("orgId"),
      kind: "saml",
      name: body.name,
      config: body.config ?? {},
      enabled: body.enabled ?? true,
    }).returning();
    return c.json({ provider: inserted }, 201);
  });

  // SP metadata for IdP-side setup.
  const saml = new Hono();
  saml.get("/metadata", c => {
    const xml = buildSpMetadata({
      entityId: c.req.query("entityId") ?? `${publicBaseUrl}/saml`,
      acsUrl: `${publicBaseUrl}/api/v1/sso/saml/acs`,
    });
    return c.body(xml, 200, { "content-type": "application/samlmetadata+xml" });
  });

  return { public: pub, orgs, saml };
}
