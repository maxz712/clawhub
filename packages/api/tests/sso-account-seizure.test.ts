import { describe, it, expect } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { SignedXml } from "xml-crypto";
import { eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { organizations, orgMembers, ssoProviders, ssoStates, users } from "../src/models/schema.js";
import { hashPassword } from "../src/services/auth.js";
import { completeSamlFlow } from "../src/services/saml.js";
import { assertSignInAllowed } from "../src/services/token-revocation.js";

process.env.JWT_SECRET ??= "test-secret-sso";

// #153 — the SSO cross-tenant guard was satisfied by a membership the attacker
// writes: POST /orgs/:id/members (and SCIM POST /Users) mint the org_members row
// saml.ts/oidc.ts treat as consent. So any free account could seize any account
// on the instance (gh-mirror included). The fix: SSO admits a pre-existing
// account only through a CONSENT-backed membership (invite_accepted / sso_jit),
// and no sign-in path resolves a kind='service' account.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENTITY = "attacker-sp-entity";

function assertionXml(nameId: string): string {
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="2024-01-01T00:00:00Z">` +
    `<saml:Issuer>https://attacker.idp/metadata</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID></saml:Subject>` +
    `<saml:Conditions NotBefore="2000-01-01T00:00:00Z" NotOnOrAfter="2999-01-01T00:00:00Z">` +
    `<saml:AudienceRestriction><saml:Audience>${ENTITY}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `</saml:Assertion>`;
}
function sign(xml: string): string {
  const sig = new SignedXml({ privateKey, signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']", action: "append" } });
  return sig.getSignedXml();
}

describe("assertSignInAllowed (#153)", () => {
  it("rejects a disabled account and a service-kind account", () => {
    expect(() => assertSignInAllowed({ disabledAt: new Date(), kind: "human" })).toThrow();
    expect(() => assertSignInAllowed({ disabledAt: null, kind: "service" })).toThrow();
    expect(() => assertSignInAllowed({ disabledAt: null, kind: "human" })).not.toThrow();
    expect(() => assertSignInAllowed({ disabledAt: null })).not.toThrow();
  });
});

describe.skipIf(!hasTestDb)("SSO account seizure (#153)", () => {
  const S = Date.now();
  let seq = 0;

  async function makeOrg() {
    const [o] = await db.insert(organizations).values({ name: `sso-seize-${++seq}-${S}` }).returning();
    return o;
  }
  async function makeProvider(orgId: string) {
    // The attacker's OWN self-signed cert is the pinned trust anchor — exactly the
    // exploit's step 5. verifySignedContent will verify against it.
    const [p] = await db.insert(ssoProviders).values({
      orgId, kind: "saml", name: `idp-${++seq}`,
      config: { entityId: ENTITY, audience: ENTITY, ssoUrl: "https://attacker.idp/sso", acsUrl: "https://sp/acs", x509cert: publicKey },
    }).returning();
    return p;
  }
  async function mkState(providerId: string): Promise<string> {
    const state = randomBytes(16).toString("base64url");
    await db.insert(ssoStates).values({ state, providerId, expiresAt: new Date(Date.now() + 10 * 60_000) });
    return state;
  }
  function respFor(email: string): string {
    return Buffer.from(sign(assertionXml(email)), "utf8").toString("base64");
  }

  it("REJECTS a pre-existing account whose only membership is admin_added (the exploit)", async () => {
    const org = await makeOrg();
    const provider = await makeProvider(org.id);
    const [victim] = await db.insert(users).values({
      email: `victim-${S}@bigco.com`, username: `victim${S}`, passwordHash: await hashPassword("x"),
    }).returning();
    // The attacker unilaterally minted this row via POST /orgs/:id/members.
    await db.insert(orgMembers).values({ orgId: org.id, userId: victim.id, source: "admin_added" });

    const state = await mkState(provider.id);
    await expect(completeSamlFlow(db, respFor(victim.email), state)).rejects.toThrow(/not_org_member/);
  });

  it("ALLOWS a pre-existing account with a consent-backed (invite_accepted) membership", async () => {
    const org = await makeOrg();
    const provider = await makeProvider(org.id);
    const [u] = await db.insert(users).values({
      email: `invitee-${S}@bigco.com`, username: `invitee${S}`, passwordHash: await hashPassword("x"),
    }).returning();
    await db.insert(orgMembers).values({ orgId: org.id, userId: u.id, source: "invite_accepted" });

    const state = await mkState(provider.id);
    const out = await completeSamlFlow(db, respFor(u.email), state);
    expect(out.userId).toBe(u.id);
  });

  it("JIT-provisions a brand-new email into the org with source sso_jit", async () => {
    const org = await makeOrg();
    const provider = await makeProvider(org.id);
    const email = `fresh-${S}@bigco.com`;
    const state = await mkState(provider.id);
    const out = await completeSamlFlow(db, respFor(email), state);
    expect(out.userId).toBeTruthy();
    const m = (await db.select().from(orgMembers).where(eq(orgMembers.userId, out.userId)).limit(1))[0];
    expect(m.source).toBe("sso_jit");
  });

  it("REFUSES a session as a kind='service' account even with a membership row (gh-mirror)", async () => {
    const org = await makeOrg();
    const provider = await makeProvider(org.id);
    const [svc] = await db.insert(users).values({
      email: `svc-gh-mirror-${S}@clawhub.invalid`, username: `svcmirror${S}`, kind: "service", passwordHash: await hashPassword("x"),
    }).returning();
    // Even an invite_accepted row must not make a service account sign-in-able.
    await db.insert(orgMembers).values({ orgId: org.id, userId: svc.id, source: "invite_accepted" });

    const state = await mkState(provider.id);
    await expect(completeSamlFlow(db, respFor(svc.email), state)).rejects.toThrow();
  });
});
