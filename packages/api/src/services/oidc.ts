import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { ssoProviders, ssoStates, users } from "../models/schema.js";
import { signToken } from "./auth.js";
import { hashPassword } from "./auth.js";
import { AuthError, NotFoundError, ValidationError } from "./errors.js";

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
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
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
  const row = (await db.select().from(ssoStates).where(eq(ssoStates.state, state)).limit(1))[0];
  if (!row) throw new AuthError("sso_state_not_found");
  if (row.expiresAt < new Date()) throw new AuthError("sso_state_expired");
  const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, row.providerId)).limit(1))[0];
  if (!provider) throw new AuthError("sso_provider_gone");
  const cfg = provider.config as OidcConfig;
  const doc = await discover(cfg.issuer);

  const tokenRes = await fetch(doc.token_endpoint, {
    method: "POST",
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

  const userRes = await fetch(doc.userinfo_endpoint, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new AuthError(`oidc_userinfo_failed:${userRes.status}`);
  const info = (await userRes.json()) as { email?: string; name?: string; sub?: string };
  if (!info.email) throw new AuthError("oidc_no_email");

  let user = (await db.select().from(users).where(eq(users.email, info.email)).limit(1))[0];
  if (!user) {
    const pwHash = await hashPassword(`sso:${randomBytes(32).toString("hex")}`);
    [user] = await db.insert(users).values({
      email: info.email,
      name: info.name ?? null,
      passwordHash: pwHash,
    }).returning();
  }

  // Clean up the one-time state row.
  await db.delete(ssoStates).where(eq(ssoStates.state, state));

  const token = signToken({ kind: "user", userId: user.id, email: user.email });
  return { token, userId: user.id, redirectTo: row.redirectTo };
}
