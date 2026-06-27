import { createPublicKey, createVerify, randomBytes } from "node:crypto";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, ssoProviders, ssoStates, users } from "../models/schema.js";
import { hashPassword, signToken } from "./auth.js";
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

  // Structural anti-wrapping (XSW): reject a document carrying more than one
  // Assertion or more than one Signature. The classic signature-wrapping attack
  // smuggles a second, attacker-authored Assertion alongside the legitimately
  // signed one; refusing multiplicity removes that maneuver. (NOTE: this is a
  // hardening heuristic — the enveloped-signature check below is still not a full
  // XML-DSig digest/canonicalization verification. TODO: migrate
  // verifyEnvelopedSignature to xml-crypto so the signature is cryptographically
  // bound to the referenced element. See security audit C2.)
  if (countTag(xml, "Assertion") > 1) throw new AuthError("saml_multiple_assertions");
  if (countTag(xml, "Signature") > 1) throw new AuthError("saml_multiple_signatures");

  // Verify enveloped signature on the Assertion or Response.
  const sigOk = verifyEnvelopedSignature(xml, cfg.x509cert);
  if (!sigOk) throw new AuthError("saml_invalid_signature");

  // Destination, if asserted, must be our ACS URL (prevents a response minted for
  // a different SP/endpoint being replayed here).
  const destMatch = xml.match(/\bDestination="([^"]+)"/);
  if (destMatch && cfg.acsUrl && destMatch[1] !== cfg.acsUrl) throw new AuthError("saml_destination_mismatch");

  // Temporal validity: Conditions NotBefore/NotOnOrAfter + SubjectConfirmationData
  // NotOnOrAfter (with small clock skew). An expired assertion is rejected so a
  // leaked old response cannot be reused.
  const now = Date.now();
  const SKEW = 5 * 60_000;
  for (const m of xml.matchAll(/\bNotOnOrAfter="([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && now > t + SKEW) throw new AuthError("saml_assertion_expired");
  }
  for (const m of xml.matchAll(/\bNotBefore="([^"]+)"/g)) {
    const t = Date.parse(m[1]);
    if (Number.isFinite(t) && now + SKEW < t) throw new AuthError("saml_assertion_not_yet_valid");
  }

  // Validate audience.
  const audience = cfg.audience ?? cfg.entityId;
  const audMatch = xml.match(/<saml2?:Audience[^>]*>([^<]+)<\/saml2?:Audience>/);
  if (!audMatch || audMatch[1].trim() !== audience) throw new AuthError("saml_audience_mismatch");

  // Extract NameID (the email).
  const nameMatch = xml.match(/<saml2?:NameID[^>]*>([^<]+)<\/saml2?:NameID>/);
  const email = nameMatch?.[1].trim().toLowerCase();
  if (!email) throw new AuthError("saml_no_nameid");

  // Pull a display name attribute if present.
  const displayMatch = xml.match(/Name="(?:displayName|name|cn)"[^>]*>\s*<saml2?:AttributeValue[^>]*>([^<]+)</i);
  const displayName = displayMatch?.[1]?.trim();

  // Cross-tenant guard (audit C3): bind the login to the provider's org. An SSO
  // provider is configured by an org admin who controls its signing cert, so we
  // must NOT resolve an arbitrary global account by email — only a user who is
  // already a member of THIS provider's org, or a brand-new account we provision
  // INTO that org. Otherwise a malicious org admin could assert a victim's email
  // and seize their account in a different tenant.
  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
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

export function verifyEnvelopedSignature(xml: string, certPem: string): boolean {
  // Locate the Signature element.
  const sigMatch = xml.match(/<(?:ds:)?Signature[\s\S]*?<\/(?:ds:)?Signature>/);
  if (!sigMatch) return false;
  const sigXml = sigMatch[0];

  // Extract SignedInfo + its canonical block as-is (we use the raw bytes — a
  // best-effort inclusive canonicalization adequate for typical IdP output).
  const sigInfoMatch = sigXml.match(/<(?:ds:)?SignedInfo[\s\S]*?<\/(?:ds:)?SignedInfo>/);
  if (!sigInfoMatch) return false;
  const signedInfo = sigInfoMatch[0];

  const sigValueMatch = sigXml.match(/<(?:ds:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:ds:)?SignatureValue>/);
  if (!sigValueMatch) return false;
  const signatureValue = sigValueMatch[1].replace(/\s+/g, "");

  const algoMatch = signedInfo.match(/SignatureMethod[^>]+Algorithm="([^"]+)"/);
  const algo = algoMatch?.[1] ?? "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const hash = algo.endsWith("rsa-sha256") ? "RSA-SHA256"
    : algo.endsWith("rsa-sha1") ? "RSA-SHA1"
    : algo.endsWith("rsa-sha512") ? "RSA-SHA512"
    : "RSA-SHA256";

  try {
    const pubKey = createPublicKey(certPem.trim());
    const verifier = createVerify(hash);
    verifier.update(signedInfo);
    verifier.end();
    return verifier.verify(pubKey, Buffer.from(signatureValue, "base64"));
  } catch {
    return false;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeXml(s); }
