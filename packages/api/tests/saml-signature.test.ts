import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { SignedXml } from "xml-crypto";
import { verifySignedContent } from "../src/services/saml.js";

// Proves the xml-crypto-based SAML signature verification (audit C2): a correctly
// signed assertion verifies and yields the SIGNED content; tampering is rejected;
// and a signature-wrapping attack cannot smuggle an attacker NameID, because
// identity is read only from the digest-verified signed reference.

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function assertionXml(nameId: string): string {
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion1" Version="2.0" IssueInstant="2024-01-01T00:00:00Z">` +
    `<saml:Issuer>https://idp.example/metadata</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID></saml:Subject>` +
    `<saml:Conditions NotBefore="2000-01-01T00:00:00Z" NotOnOrAfter="2999-01-01T00:00:00Z">` +
    `<saml:AudienceRestriction><saml:Audience>sp-entity</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
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

describe("verifySignedContent (SAML XML-DSig — audit C2)", () => {
  it("accepts a correctly signed assertion and returns the signed content", () => {
    const signed = sign(assertionXml("alice@corp.example"));
    const out = verifySignedContent(signed, publicKey);
    expect(out).not.toBeNull();
    expect(out!).toContain("alice@corp.example");
  });

  it("rejects when the signed content is tampered after signing (digest mismatch)", () => {
    const signed = sign(assertionXml("alice@corp.example"));
    const tampered = signed.replace("alice@corp.example", "attacker@evil.example");
    expect(verifySignedContent(tampered, publicKey)).toBeNull();
  });

  it("rejects verification under a different (untrusted) key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const signed = sign(assertionXml("alice@corp.example"));
    expect(verifySignedContent(signed, other.publicKey)).toBeNull();
  });

  it("signature wrapping: the returned signed content carries the SIGNED NameID, not an injected one", () => {
    const signed = sign(assertionXml("alice@corp.example"));
    // Wrap: smuggle a forged assertion alongside the legitimately signed one.
    const forged = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_evil"><saml:Subject><saml:NameID>attacker@evil.example</saml:NameID></saml:Subject></saml:Assertion>`;
    const wrapped = signed.replace("<saml:Assertion", forged + "<saml:Assertion");
    const out = verifySignedContent(wrapped, publicKey);
    // checkSignature still validates the intact signed assertion; the signed
    // reference content is what we return — and it is the original, not the forgery.
    if (out !== null) {
      expect(out).toContain("alice@corp.example");
      expect(out).not.toContain("attacker@evil.example");
    }
  });

  it("returns null when there is no signature at all", () => {
    expect(verifySignedContent(assertionXml("alice@corp.example"), publicKey)).toBeNull();
  });
});
