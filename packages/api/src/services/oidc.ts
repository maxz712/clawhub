import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, ssoProviders, ssoStates, users } from "../models/schema.js";
import { signToken } from "./auth.js";
import { hashPassword } from "./auth.js";
import { AuthError, NotFoundError, ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

export interface OidcConfig {
  issuer: string;                  // e.g. https://accounts.google.com
  clientId: string;
  clientSecret: string;
  scopes?: string;                 // defaults to "openid email profile"
  redirectUri: string;             // absolute URL to our /auth/sso/callback
}

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>();

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.doc;
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  // SSRF guard: a configured issuer must resolve to a public host (defense in
  // depth alongside the create/edit-time validation and the test endpoint).
  const blocked = await assertPublicHttpHost(url);
  if (blocked) throw new AuthError("oidc_discovery_blocked");
  const res = await fetch(url, { redirect: "manual" }); // SSRF guard: don't follow redirects to unvetted hosts.
  if (!res.ok) throw new AuthError(`oidc_discovery_failed:${res.status}`);
  const doc = (await res.json()) as OidcDiscovery;
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// Best-effort decode of the id_token payload (claims only) so we can prefer its
// email/email_verified over the userinfo response. Signature is not verified
// here — these claims are only TRUSTED for the verified-email gate when present,
// and the email-verified check below still rejects unless email_verified===true.
function decodeIdTokenClaims(idToken: string | undefined): { email?: string; email_verified?: boolean | string } | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}

export async function beginOidcFlow(db: DB, providerId: string, redirectTo?: string): Promise<{ authorizeUrl: string }> {
  const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, providerId)).limit(1))[0];
  if (!provider) throw new NotFoundError("sso provider");
  if (provider.kind !== "oidc" || !provider.enabled) throw new ValidationError("provider not oidc or disabled");

  const cfg = provider.config as OidcConfig;
  if (!cfg.issuer || !cfg.clientId || !cfg.redirectUri) throw new ValidationError("provider config incomplete");

  const doc = await discover(cfg.issuer);
  const state = base64url(randomBytes(32));
  const { verifier, challenge } = makePkce();

  await db.insert(ssoStates).values({
    state,
    providerId,
    codeVerifier: verifier,
    redirectTo: redirectTo ?? null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });

  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scopes ?? "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorizeUrl: url.toString() };
}

export async function completeOidcFlow(db: DB, state: string, code: string): Promise<{ token: string; userId: string; redirectTo: string | null }> {
  // Consume the state ATOMICALLY (delete-returning) as the FIRST database action,
  // before any outbound fetch to the IdP: mirrors completeSamlFlow so a captured
  // (state, code) pair can't be replayed — a concurrent/second call finds no row.
  const consumed = await db.delete(ssoStates).where(eq(ssoStates.state, state)).returning();
  const row = consumed[0];
  if (!row) throw new AuthError("sso_state_not_found");
  if (row.expiresAt < new Date()) throw new AuthError("sso_state_expired");
  const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, row.providerId)).limit(1))[0];
  if (!provider) throw new AuthError("sso_provider_gone");
  const cfg = provider.config as OidcConfig;
  const doc = await discover(cfg.issuer);

  // SSRF guard: an attacker-controlled issuer can point token/userinfo at
  // internal/metadata addresses, so each outbound endpoint must resolve public.
  const tokenBlocked = await assertPublicHttpHost(doc.token_endpoint);
  if (tokenBlocked) throw new AuthError("oidc_token_endpoint_blocked");
  const tokenRes = await fetch(doc.token_endpoint, {
    method: "POST",
    redirect: "manual", // SSRF guard: don't follow redirects to unvetted hosts.
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: row.codeVerifier ?? "",
    }),
  });
  if (!tokenRes.ok) throw new AuthError(`oidc_token_exchange_failed:${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as { access_token: string; id_token?: string };

  const userinfoBlocked = await assertPublicHttpHost(doc.userinfo_endpoint);
  if (userinfoBlocked) throw new AuthError("oidc_userinfo_endpoint_blocked");
  const userRes = await fetch(doc.userinfo_endpoint, {
    redirect: "manual", // SSRF guard: don't follow redirects to unvetted hosts.
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new AuthError(`oidc_userinfo_failed:${userRes.status}`);
  const info = (await userRes.json()) as { email?: string; email_verified?: boolean | string; name?: string; sub?: string };

  // Prefer the id_token's claims (it's bound to this exchange) over userinfo.
  const idClaims = decodeIdTokenClaims(tokens.id_token);
  const email = (idClaims?.email ?? info.email)?.trim().toLowerCase();
  if (!email) throw new AuthError("oidc_no_email");

  // Verified-email gate: mirror the consumer GitHub/Google flow (which only
  // links/creates on a provider-asserted verified email). An IdP an attacker
  // controls could otherwise assert any victim's address. Accept boolean true
  // or the string "true" (some IdPs serialize claims as strings).
  const ev = idClaims?.email_verified ?? info.email_verified;
  if (ev !== true && ev !== "true") throw new AuthError("oidc_email_unverified");

  // Cross-tenant binding: an OIDC provider belongs to ONE org. A pre-existing
  // global account is NOT resolvable by email alone — only if it is already a
  // member of THIS provider's org; otherwise reject. Without this an org admin
  // could point a provider at an IdP they control and assert a victim's email
  // to seize that account cross-tenant. A brand-new account (no global match)
  // is created and auto-provisioned into this org on first SSO login.
  const orgId = provider.orgId;
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (user) {
    const member = (await db.select({ id: orgMembers.id }).from(orgMembers).where(and(
      eq(orgMembers.orgId, orgId),
      eq(orgMembers.userId, user.id),
    )).limit(1))[0];
    if (!member) throw new AuthError("oidc_not_org_member"); // refuse to absorb an existing account cross-tenant.
  } else {
    const pwHash = await hashPassword(`sso:${randomBytes(32).toString("hex")}`);
    [user] = await db.insert(users).values({
      email,
      name: info.name ?? null,
      passwordHash: pwHash,
    }).returning();
    await db.insert(orgMembers).values({ orgId, userId: user.id }).onConflictDoNothing();
  }

  // The one-time state row was already consumed atomically at the top of the flow.
  const token = signToken({ kind: "user", userId: user.id, email: user.email, v: user.tokenVersion });
  return { token, userId: user.id, redirectTo: row.redirectTo };
}
