import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { hashPassword, randomToken, signToken } from "../services/auth.js";
import { log } from "../services/logger.js";

/**
 * Consumer OAuth sign-in (GitHub + Google, authorization-code flow).
 *
 * GET /providers            → which providers are configured (drives login UI)
 * GET /:provider/start      → 302 to the provider's consent screen
 * GET /:provider/callback   → code → token → email → find-or-create user →
 *                             redirect to the dashboard with a session JWT in
 *                             the URL fragment (fragments never hit logs).
 *
 * Provider endpoints are env-overridable so the flow can be exercised against
 * a stub in tests; secrets stay server-side throughout.
 */

interface Provider {
  name: "github" | "google";
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  fetchEmail: (accessToken: string) => Promise<{ email: string; name?: string; avatarUrl?: string } | null>;
}

function githubProvider(): Provider | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const api = process.env.GITHUB_OAUTH_API_BASE ?? "https://api.github.com";
  return {
    name: "github", clientId, clientSecret,
    authorizeUrl: process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? "https://github.com/login/oauth/authorize",
    tokenUrl: process.env.GITHUB_OAUTH_TOKEN_URL ?? "https://github.com/login/oauth/access_token",
    scope: "read:user user:email",
    async fetchEmail(accessToken) {
      const headers = { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": "clawhub" };
      const user = await (await fetch(`${api}/user`, { headers })).json() as { email?: string; name?: string; login?: string; avatar_url?: string };
      let email = user.email ?? null;
      if (!email) {
        const emails = await (await fetch(`${api}/user/emails`, { headers })).json() as Array<{ email: string; primary: boolean; verified: boolean }>;
        email = emails.find(e => e.primary && e.verified)?.email ?? emails.find(e => e.verified)?.email ?? null;
      }
      if (!email) return null;
      return { email, name: user.name ?? user.login, avatarUrl: user.avatar_url };
    },
  };
}

function googleProvider(): Provider | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const userinfoUrl = process.env.GOOGLE_OAUTH_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo";
  return {
    name: "google", clientId, clientSecret,
    authorizeUrl: process.env.GOOGLE_OAUTH_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    async fetchEmail(accessToken) {
      const info = await (await fetch(userinfoUrl, { headers: { authorization: `Bearer ${accessToken}` } })).json() as { email?: string; email_verified?: boolean; name?: string; picture?: string };
      if (!info.email || info.email_verified === false) return null;
      return { email: info.email, name: info.name, avatarUrl: info.picture };
    },
  };
}

function getProvider(name: string): Provider | null {
  if (name === "github") return githubProvider();
  if (name === "google") return googleProvider();
  return null;
}

// CSRF state: HMAC over provider + expiry, keyed by JWT_SECRET. Stateless on
// purpose — no Redis dependency on the login path.
function makeState(provider: string): string {
  const payload = `${provider}.${Date.now() + 10 * 60_000}.${randomToken(8)}`;
  const sig = createHmac("sha256", process.env.JWT_SECRET ?? "dev-secret-change-me").update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function checkState(provider: string, state: string | undefined): boolean {
  if (!state) return false;
  const i = state.lastIndexOf(".");
  if (i < 0) return false;
  const payload = state.slice(0, i);
  const sig = state.slice(i + 1);
  const expected = createHmac("sha256", process.env.JWT_SECRET ?? "dev-secret-change-me").update(payload).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const [p, exp] = payload.split(".");
  return p === provider && Number(exp) > Date.now();
}

export function createOAuthRoutes(db: DB, publicBaseUrl: string): Hono {
  const app = new Hono();
  const dashboardUrl = (process.env.CLAWHUB_DASHBOARD_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(/\/+$/, "");
  const redirectUri = (provider: string) => `${publicBaseUrl.replace(/\/+$/, "")}/api/v1/oauth/${provider}/callback`;
  const fail = (reason: string) => `${dashboardUrl}/login?error=${encodeURIComponent(reason)}`;

  app.get("/providers", c => {
    const providers = ["github", "google"].filter(n => getProvider(n) !== null);
    return c.json({ providers });
  });

  app.get("/:provider/start", c => {
    const p = getProvider(c.req.param("provider"));
    if (!p) return c.json({ error: "provider_not_configured" }, 404);
    const url = new URL(p.authorizeUrl);
    url.searchParams.set("client_id", p.clientId);
    url.searchParams.set("redirect_uri", redirectUri(p.name));
    url.searchParams.set("scope", p.scope);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", makeState(p.name));
    return c.redirect(url.toString(), 302);
  });

  app.get("/:provider/callback", async c => {
    const p = getProvider(c.req.param("provider"));
    if (!p) return c.json({ error: "provider_not_configured" }, 404);
    if (!checkState(p.name, c.req.query("state"))) return c.redirect(fail("oauth_state_mismatch"), 302);
    const code = c.req.query("code");
    if (!code) return c.redirect(fail("oauth_denied"), 302);

    try {
      const tokenRes = await fetch(p.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          client_id: p.clientId, client_secret: p.clientSecret,
          code, redirect_uri: redirectUri(p.name), grant_type: "authorization_code",
        }),
      });
      const token = await tokenRes.json() as { access_token?: string; error?: string };
      if (!token.access_token) {
        log("warn", "oauth_token_exchange_failed", { provider: p.name, err: token.error ?? `status_${tokenRes.status}` });
        return c.redirect(fail("oauth_token_exchange_failed"), 302);
      }

      const identity = await p.fetchEmail(token.access_token);
      if (!identity) return c.redirect(fail("oauth_no_verified_email"), 302);

      let user = (await db.select().from(users).where(eq(users.email, identity.email.toLowerCase())).limit(1))[0];
      if (!user) {
        // OAuth-only account: unguessable password; password login stays
        // possible later via the reset flow.
        const passwordHash = await hashPassword(randomToken(24));
        user = (await db.insert(users).values({
          email: identity.email.toLowerCase(),
          name: identity.name,
          avatarUrl: identity.avatarUrl,
          passwordHash,
        }).returning())[0];
        log("info", "oauth_user_created", { provider: p.name, userId: user.id });
      }

      const jwt = signToken({ kind: "user", userId: user.id, email: user.email });
      return c.redirect(`${dashboardUrl}/login/oauth#token=${encodeURIComponent(jwt)}`, 302);
    } catch (e) {
      log("warn", "oauth_callback_failed", { provider: p.name, err: (e as Error).message });
      return c.redirect(fail("oauth_failed"), 302);
    }
  });

  return app;
}
