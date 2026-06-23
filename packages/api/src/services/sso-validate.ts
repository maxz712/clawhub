// SSO provider config validation + a "test connection" probe. Kept separate
// from routes/sso.ts so the pure logic (field validation, URL safety, the
// discovery/cert checks) is unit-testable without booting a server, and so the
// PATCH (edit) handler validates the SAME way create does.

import type { OidcConfig } from "./oidc.js";
import { discover } from "./oidc.js";
import type { SamlConfig } from "./saml.js";
import { ValidationError } from "./errors.js";
import { assertPublicHttpHost } from "./url-guard.js";

export type SsoKind = "oidc" | "saml";

// A non-throwing structured result the "Test connection" endpoint returns. A
// failure is `ok:false` with a helpful `detail` — never a 500 — so an admin can
// see exactly what's wrong (bad issuer, unreachable endpoint, missing field).
export interface TestConnectionResult {
  ok: boolean;
  detail: string;
  discovered?: Record<string, unknown>;
}

// Only http(s) URLs may be probed/configured. Blocks non-http schemes (file:,
// gopher:, etc.). NOTE: this is scheme-only — host-level SSRF safety (rejecting
// private/loopback/cloud-metadata IPs) is enforced separately at fetch time by
// `assertPublicHttpHost`; do not rely on this for SSRF protection.
export function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  let u: URL;
  try { u = new URL(s); } catch { return false; }
  return u.protocol === "http:" || u.protocol === "https:";
}

// Validate a provider's mutable config the same way create/edit must. Throws a
// ValidationError on the first problem so the caller returns a 400.
export function validateProviderConfig(kind: SsoKind, config: Record<string, unknown>): void {
  if (kind === "oidc") {
    const cfg = config as Partial<OidcConfig>;
    if (!isHttpUrl(cfg.issuer)) throw new ValidationError("oidc issuer must be an http(s) URL");
    if (!cfg.clientId || typeof cfg.clientId !== "string") throw new ValidationError("oidc clientId required");
    if (!cfg.clientSecret || typeof cfg.clientSecret !== "string") throw new ValidationError("oidc clientSecret required");
    if (!isHttpUrl(cfg.redirectUri)) throw new ValidationError("oidc redirectUri must be an http(s) URL");
    return;
  }
  const cfg = config as Partial<SamlConfig>;
  if (!cfg.entityId || typeof cfg.entityId !== "string") throw new ValidationError("saml entityId required");
  if (!isHttpUrl(cfg.ssoUrl)) throw new ValidationError("saml ssoUrl must be an http(s) URL");
  if (!cfg.x509cert || typeof cfg.x509cert !== "string") throw new ValidationError("saml x509cert (PEM) required");
  if (!isHttpUrl(cfg.acsUrl)) throw new ValidationError("saml acsUrl must be an http(s) URL");
}

// The required OIDC discovery fields per the OpenID Connect Discovery spec we
// rely on to drive a login. A provider missing any of these cannot complete a
// sign-in, so we surface it here rather than at first-login time.
const REQUIRED_OIDC_DISCOVERY = ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const;

// Probe an OIDC issuer's discovery document. Network/parse failures return
// ok:false with a helpful detail — never throw — so the endpoint stays a 200.
export async function testOidcConnection(config: Record<string, unknown>, timeoutMs = 5000): Promise<TestConnectionResult> {
  const issuer = (config as Partial<OidcConfig>).issuer;
  if (!isHttpUrl(issuer)) return { ok: false, detail: "issuer must be an http(s) URL" };
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  // SSRF guard: never probe a private/loopback/metadata host (an org admin must
  // not be able to scan ClawHub's internal network via this endpoint).
  const blocked = await assertPublicHttpHost(url);
  if (blocked) return { ok: false, detail: `issuer not allowed: ${blocked}` };
  let doc: unknown;
  try {
    // `redirect: "manual"` so a 30x cannot bounce the probe to an internal
    // target after the host check (discovery docs are served directly).
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "application/json" } });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      return { ok: false, detail: "issuer discovery endpoint redirected; configure the canonical issuer URL" };
    }
    if (!res.ok) return { ok: false, detail: `discovery fetch failed: HTTP ${res.status}` };
    doc = await res.json();
  } catch (e) {
    const msg = e instanceof Error && e.name === "TimeoutError" ? "discovery request timed out" : `could not reach issuer (${(e as Error).message})`;
    return { ok: false, detail: msg };
  }
  // Guard the body shape before any property access so a 200 with a non-object
  // body (null/array/number) returns ok:false instead of throwing a 500.
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, detail: "discovery document was not a JSON object" };
  }
  const record = doc as Record<string, unknown>;
  const missing = REQUIRED_OIDC_DISCOVERY.filter(k => typeof record[k] !== "string" || (record[k] as string).length === 0);
  if (missing.length) return { ok: false, detail: `discovery document missing required fields: ${missing.join(", ")}`, discovered: pickDiscovery(record) };
  return { ok: true, detail: "OIDC discovery document is valid", discovered: pickDiscovery(record) };
}

function pickDiscovery(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...REQUIRED_OIDC_DISCOVERY, "userinfo_endpoint"]) {
    if (typeof doc[k] === "string") out[k] = doc[k];
  }
  return out;
}

// Validate a SAML provider's configured IdP signing certificate (PEM). Parses
// the cert locally — no network — so it's purely deterministic. ok:false with a
// detail on any problem; never throws.
export async function testSamlConnection(config: Record<string, unknown>): Promise<TestConnectionResult> {
  const cfg = config as Partial<SamlConfig>;
  if (!cfg.x509cert || typeof cfg.x509cert !== "string") return { ok: false, detail: "no x509 certificate configured" };
  if (!isHttpUrl(cfg.ssoUrl)) return { ok: false, detail: "ssoUrl must be an http(s) URL" };
  const { createPublicKey, X509Certificate } = await import("node:crypto");
  const pem = cfg.x509cert.trim();
  try {
    if (pem.includes("BEGIN CERTIFICATE")) {
      const cert = new X509Certificate(pem);
      const detail = `certificate parsed (subject ${cert.subject ?? "?"}, valid until ${cert.validTo})`;
      return { ok: true, detail, discovered: { subject: cert.subject, validTo: cert.validTo, ssoUrl: cfg.ssoUrl } };
    }
    // Accept a raw public key PEM as well — verifyEnvelopedSignature uses
    // createPublicKey, which accepts both.
    createPublicKey(pem);
    return { ok: true, detail: "public key parsed", discovered: { ssoUrl: cfg.ssoUrl } };
  } catch (e) {
    return { ok: false, detail: `could not parse x509 certificate: ${(e as Error).message}` };
  }
}

// Dispatch by kind. Pure orchestration over the two probes above.
export async function testConnection(kind: SsoKind, config: Record<string, unknown>, timeoutMs = 5000): Promise<TestConnectionResult> {
  return kind === "oidc" ? testOidcConnection(config, timeoutMs) : testSamlConnection(config);
}

// Re-export discover so callers that want the cached path can use it; testOidc
// deliberately does its own fetch so it can apply a per-probe timeout and never
// poison the login-path discovery cache with a transient failure.
export { discover };
