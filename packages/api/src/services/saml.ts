import { randomBytes } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, ssoProviders, ssoStates, users } from "../models/schema.js";
import { hashPassword, signToken } from "./auth.js";
import { assertNotDeprovisioned } from "./token-revocation.js";
import { AuthError, NotFoundError, ValidationError } from "./errors.js";

export interface SamlConfig {
  entityId: string;           // our SP entity ID
  ssoUrl: string;             // IdP SSO endpoint
  x509cert: string;           // IdP signing cert (PEM, with BEGIN/END)
  audience?: string;          // defaults to entityId
  acsUrl: string;             // our ACS URL (absolute)
}

function uuid(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function beginSamlFlow(db: DB, providerId: string, redirectTo?: string): Promise<{ redirectUrl: string }> {
  const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, providerId)).limit(1))[0];
  if (!provider) throw new NotFoundError("sso provider");
  if (provider.kind !== "saml" || !provider.enabled) throw new ValidationError("provider not saml or disabled");
  const cfg = provider.config as SamlConfig;
  if (!cfg.entityId || !cfg.ssoUrl || !cfg.x509cert || !cfg.acsUrl) throw new ValidationError("saml config incomplete");

  const id = `id-${uuid()}`;
  const state = randomBytes(16).toString("base64url");
  const instant = new Date().toISOString();

  const authn = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${id}" Version="2.0" IssueInstant="${instant}"
  Destination="${escapeAttr(cfg.ssoUrl)}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
  AssertionConsumerServiceURL="${escapeAttr(cfg.acsUrl)}">
  <saml:Issuer>${escapeXml(cfg.entityId)}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`;

  // HTTP-Redirect binding: DEFLATE + base64 + URL params.
  const { deflateRawSync } = await import("node:zlib");
  const deflated = deflateRawSync(Buffer.from(authn));
  const samlRequest = deflated.toString("base64");

  await db.insert(ssoStates).values({
    state,
    providerId,
    codeVerifier: id,
    redirectTo: redirectTo ?? null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });

  const url = new URL(cfg.ssoUrl);
  url.searchParams.set("SAMLRequest", samlRequest);
  url.searchParams.set("RelayState", state);
  return { redirectUrl: url.toString() };
}

export async function completeSamlFlow(db: DB, samlResponseB64: string, relayState: string): Promise<{ token: string; userId: string; redirectTo: string | null }> {
  // Consume the RelayState ATOMICALLY (delete-returning) so a captured response
  // can't be replayed: a concurrent/second use finds no row.
  const consumed = await db.delete(ssoStates).where(eq(ssoStates.state, relayState)).returning();
  const row = consumed[0];
  if (!row) throw new AuthError("saml_state_not_found");
  if (row.expiresAt < new Date()) throw new AuthError("saml_state_expired");
  const provider = (await db.select().from(ssoProviders).where(eq(ssoProviders.id, row.providerId)).limit(1))[0];
  if (!provider) throw new AuthError("saml_provider_gone");
  const cfg = provider.config as SamlConfig;

  let xml = Buffer.from(samlResponseB64, "base64").toString("utf8");
  if (!xml.startsWith("<")) {
    // Try deflate/gzip unwraps.
    try { xml = inflateRawSync(Buffer.from(samlResponseB64, "base64")).toString("utf8"); } catch {}
    if (!xml.startsWith("<")) {
      try { xml = gunzipSync(Buffer.from(samlResponseB64, "base64")).toString("utf8"); } catch {}
    }
  }

  // Structural anti-wrapping pre-check (cheap): refuse a document carrying more
  // than one Assertion — the classic signature-wrapping attack smuggles a second,
  // attacker-authored Assertion alongside the signed one.
  if (countTag(xml, "Assertion") > 1) throw new AuthError("saml_multiple_assertions");

  // Cryptographically verify the enveloped XML-DSig signature with xml-crypto: it
  // canonicalizes, recomputes the Reference DigestValue, and binds SignatureValue
  // to the signed element with the provider's pinned cert. We then read identity
  // ONLY from the content that was actually signed (getSignedReferences) — never
  // the raw document — which is what defeats XML signature wrapping (XSW).
  const signed = verifySignedContent(xml, cfg.x509cert);
  if (!signed) throw new AuthError("saml_invalid_signature");

  // Destination, if asserted on the (possibly-unsigned) Response, must be our ACS
  // URL — a binding hint; the load-bearing checks below read SIGNED content only.
  const destMatch = xml.match(/\bDestination="([^"]+)"/);
  if (destMatch && cfg.acsUrl && destMatch[1] !== cfg.acsUrl) throw new AuthError("saml_destination_mismatch");

  // Temporal validity from the SIGNED assertion (NotBefore/NotOnOrAfter, ±5m skew)
  // so a leaked/old response cannot be reused.
  const now = Date.now();
  const SKEW = 5 * 60_000;
  for (const m of signed.matchAll(/\bNotOnOrAfter="([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && now > t + SKEW) throw new AuthError("saml_assertion_expired");
  }
  for (const m of signed.matchAll(/\bNotBefore="([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && now + SKEW < t) throw new AuthError("saml_assertion_not_yet_valid");
  }

  // Audience, NameID, and display name — all read from SIGNED content, prefix-agnostic.
  const audience = cfg.audience ?? cfg.entityId;
  const audMatch = signed.match(/<(?:[A-Za-z0-9._-]+:)?Audience[^>]*>([^<]+)<\/(?:[A-Za-z0-9._-]+:)?Audience>/);
  if (!audMatch || audMatch[1].trim() !== audience) throw new AuthError("saml_audience_mismatch");

  const nameMatch = signed.match(/<(?:[A-Za-z0-9._-]+:)?NameID[^>]*>([^<]+)<\/(?:[A-Za-z0-9._-]+:)?NameID>/);
  const email = nameMatch?.[1].trim().toLowerCase();
  if (!email) throw new AuthError("saml_no_nameid");

  const displayMatch = signed.match(/Name="(?:displayName|name|cn)"[^>]*>\s*<(?:[A-Za-z0-9._-]+:)?AttributeValue[^>]*>([^<]+)</i);
  const displayName = displayMatch?.[1]?.trim();

  // Cross-tenant guard (audit C3): bind the login to the provider's org. An SSO
  // provider is configured by an org admin who controls its signing cert, so we
  // must NOT resolve an arbitrary global account by email — only a user who is
  // already a member of THIS provider's org, or a brand-new account we provision
  // INTO that org. Otherwise a malicious org admin could assert a victim's email
  // and seize their account in a different tenant.
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  // A deprovisioned account cannot be signed back in through the IdP (#133).
  if (user) assertNotDeprovisioned(user);
  if (user) {
    const member = (await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, provider.orgId), eq(orgMembers.userId, user.id))).limit(1))[0];
    if (!member) throw new AuthError("saml_not_org_member");
  } else {
    const pwHash = await hashPassword(`sso:${randomBytes(32).toString("hex")}`);
    [user] = await db.insert(users).values({ email, name: displayName ?? null, passwordHash: pwHash }).returning();
    await db.insert(orgMembers).values({ orgId: provider.orgId, userId: user.id }).onConflictDoNothing();
  }

  const token = signToken({ kind: "user", userId: user.id, email: user.email, v: user.tokenVersion });
  return { token, userId: user.id, redirectTo: row.redirectTo };
}

// Count element occurrences by local name (ignoring ds:/saml2: prefixes), used
// for the structural anti-wrapping check. Counts start tags only.
function countTag(xml: string, local: string): number {
  const re = new RegExp(`<(?:[A-Za-z0-9]+:)?${local}[\\s>]`, "g");
  return (xml.match(re) ?? []).length;
}

// First enveloped XML-DSig Signature element (prefix-agnostic). `[\s>]` after the
// local name avoids matching <SignatureValue>/<SignatureMethod>.
const SIG_RE = /<(?:[A-Za-z0-9._-]+:)?Signature[\s>][\s\S]*?<\/(?:[A-Za-z0-9._-]+:)?Signature>/;

// Ensure the configured IdP key is a PEM xml-crypto can consume. Accepts a full
// CERTIFICATE/PUBLIC KEY PEM as-is, or wraps a bare base64 cert body.
function normalizeCert(pem: string): string {
  const t = (pem ?? "").trim();
  if (t.includes("-----BEGIN")) return t;
  const body = t.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") ?? t;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

/**
 * Cryptographically verify an enveloped XML-DSig signature with xml-crypto and
 * return the canonicalized content that was actually SIGNED (Reference digest
 * recomputed + verified, SignatureValue verified against the pinned cert), or
 * null if the signature is missing/invalid. Reading identity from the RETURN
 * value — not the raw document — is what defeats XML signature wrapping (XSW):
 * a wrapper's injected/edited elements are not part of the signed, digest-
 * verified reference. Requires exactly one signed reference.
 *
 * The Signature is passed to xml-crypto as a STRING (loadSignature accepts one)
 * so we don't import a DOM parser at the type level — @xmldom/xmldom and xpath
 * ship `/// <reference lib="dom" />`, which would pull the DOM lib into the
 * program and break Node's Buffer-bodied fetch typings elsewhere.
 */
export function verifySignedContent(xml: string, certPem: string): string | null {
  const sigMatch = xml.match(SIG_RE);
  if (!sigMatch) return null;
  try {
    const sig = new SignedXml({ publicCert: normalizeCert(certPem) });
    sig.loadSignature(sigMatch[0]);
    if (!sig.checkSignature(xml)) return null;
    const refs = sig.getSignedReferences();
    if (!refs || refs.length !== 1) return null; // exactly one signed reference
    return refs[0];
  } catch {
    return null;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeXml(s); }
