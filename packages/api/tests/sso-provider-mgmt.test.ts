import { describe, it, expect, afterEach, vi } from "vitest";
import {
  isHttpUrl,
  validateProviderConfig,
  testOidcConnection,
  testSamlConnection,
  testConnection,
} from "../src/services/sso-validate.js";
import { mergeProviderConfig } from "../src/routes/sso.js";
import { assertPublicHttpHost } from "../src/services/url-guard.js";
import { ValidationError } from "../src/services/errors.js";

// A self-signed cert (CN=test-idp) — fixed bytes so the SAML cert-parse test is
// fully deterministic and does no keygen at runtime.
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDBzCCAe+gAwIBAgIUVH1zjwOxkys2FhCdNSc8j4Bh6IswDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIdGVzdC1pZHAwHhcNMjYwNjIzMDE0MTU3WhcNMzYwNjIw
MDE0MTU3WjATMREwDwYDVQQDDAh0ZXN0LWlkcDCCASIwDQYJKoZIhvcNAQEBBQAD
ggEPADCCAQoCggEBAKDfLJgx+RkUtgCjNd2NhamoLfbL/WFRRSP+Yl9RQuut4MaL
GxmpKn5C1/2VhyhNcQE2AHgQdcLfqhyyIU8czifBjPjn2FKoEQZiaUapWi7o+aA0
cAa8zF8zuso7h7v6UQ/AVjWJIqsdbeVYJhiYHBF/ZqDotlffqpA60A3KE07Jy2nA
e6s213LZaeIwCirMektoSuNErv5s5UA7bDFarXNBCLvAhTOZ3aSljYyUp+aQP3s6
PrpcU9uG1BB2naFzaydYAu4iLT3iRGVsw11FTt/hXMOy4wUl8Mw0G/3FJEw/WaOb
ows7VEad0aDhrWxmnYEuK2LYeMBKE5OOxPXd7MECAwEAAaNTMFEwHQYDVR0OBBYE
FFNfSU6R53XVHg3axg0J2ubv/6luMB8GA1UdIwQYMBaAFFNfSU6R53XVHg3axg0J
2ubv/6luMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAJQ7ndP/
CBT41x9OeEhCInYSyyvLoHKm/78ypSOoRdT3T8pfRx1O7riULgXYUXkQ1p2nuWoP
p3A2oO5ehmEo+YWYLA0LXbDfdUfHfuO33cNqwETGlggfwr7eek/YV4ntktgdywUv
a5BjFWmRk25WuY/xO6G1So9H4/n/iPd9nwYIAs347ETDWuLhc4vbERGNjR7GZAGd
+ZC3pevN4mXpqnhQzQKTVvFM8zGsILijrZ5w3uGmac9QDd+aG5NxlpcPSifOI/tD
KYIxA81VjZmVEOIsIVpCxKYlcJb0yl1+vHOGVNa+qD4My9TyYN9HPyhTB+iK6JQR
B5wAcg/f9LjKfas=
-----END CERTIFICATE-----`;

const VALID_DISCOVERY = {
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/authorize",
  token_endpoint: "https://idp.example.com/token",
  jwks_uri: "https://idp.example.com/jwks",
  userinfo_endpoint: "https://idp.example.com/userinfo",
};

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("https://idp.example.com")).toBe(true);
    expect(isHttpUrl("http://localhost:8080/x")).toBe(true);
  });
  it("rejects non-http schemes and junk", () => {
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("ftp://x")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
    expect(isHttpUrl(123)).toBe(false);
  });
});

describe("validateProviderConfig", () => {
  it("accepts a complete OIDC config", () => {
    expect(() => validateProviderConfig("oidc", {
      issuer: "https://idp.example.com", clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb",
    })).not.toThrow();
  });
  it("rejects an OIDC config with a non-http issuer", () => {
    expect(() => validateProviderConfig("oidc", {
      issuer: "ftp://idp", clientId: "cid", clientSecret: "sec", redirectUri: "https://app/cb",
    })).toThrow(ValidationError);
  });
  it("rejects an OIDC config missing the clientSecret", () => {
    expect(() => validateProviderConfig("oidc", {
      issuer: "https://idp.example.com", clientId: "cid", redirectUri: "https://app/cb",
    })).toThrow(ValidationError);
  });
  it("accepts a complete SAML config", () => {
    expect(() => validateProviderConfig("saml", {
      entityId: "clawhub", ssoUrl: "https://idp/sso", x509cert: TEST_CERT, acsUrl: "https://app/acs",
    })).not.toThrow();
  });
  it("rejects a SAML config missing the cert", () => {
    expect(() => validateProviderConfig("saml", {
      entityId: "clawhub", ssoUrl: "https://idp/sso", acsUrl: "https://app/acs",
    })).toThrow(ValidationError);
  });
});

describe("testOidcConnection", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });

  it("returns ok:true when discovery has all required fields", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 })) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(true);
    expect(r.discovered?.token_endpoint).toBe("https://idp.example.com/token");
  });

  it("returns ok:false (not a throw) when required fields are missing", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ issuer: "https://idp.example.com" }), { status: 200 })) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("authorization_endpoint");
  });

  it("returns ok:false when the discovery fetch is not ok", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("404");
  });

  it("returns ok:false (not a throw) on a network error", async () => {
    globalThis.fetch = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });

  it("rejects a non-http issuer without fetching", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const r = await testOidcConnection({ issuer: "file:///etc/passwd" });
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks an SSRF issuer (link-local/metadata IP) WITHOUT fetching", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    const r = await testOidcConnection({ issuer: "http://169.254.169.254/latest/meta-data" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not allowed");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns ok:false (not a throw) when discovery returns a non-object body", async () => {
    globalThis.fetch = (async () => new Response("null", { status: 200 })) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not a JSON object");
  });

  it("returns ok:false when the discovery endpoint redirects", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 302 })) as typeof fetch;
    const r = await testOidcConnection({ issuer: "https://8.8.8.8" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("redirected");
  });
});

describe("assertPublicHttpHost (SSRF guard)", () => {
  it("blocks loopback / link-local / private / IPv6-loopback literal hosts", async () => {
    expect(await assertPublicHttpHost("http://127.0.0.1/x")).toBeTruthy();
    expect(await assertPublicHttpHost("http://169.254.169.254/latest/meta-data/")).toBeTruthy();
    expect(await assertPublicHttpHost("http://10.1.2.3/")).toBeTruthy();
    expect(await assertPublicHttpHost("http://192.168.1.1/")).toBeTruthy();
    expect(await assertPublicHttpHost("http://[::1]/")).toBeTruthy();
  });
  it("allows a public literal IP", async () => {
    expect(await assertPublicHttpHost("https://8.8.8.8/")).toBeNull();
  });
  it("rejects non-http schemes", async () => {
    expect(await assertPublicHttpHost("file:///etc/passwd")).toBeTruthy();
    expect(await assertPublicHttpHost("gopher://8.8.8.8/")).toBeTruthy();
  });
});

describe("testSamlConnection", () => {
  it("returns ok:true for a valid cert + ssoUrl", async () => {
    const r = await testSamlConnection({ ssoUrl: "https://idp/sso", x509cert: TEST_CERT });
    expect(r.ok).toBe(true);
    expect(String(r.detail)).toContain("certificate parsed");
  });
  it("returns ok:false for a malformed cert (no throw)", async () => {
    const r = await testSamlConnection({ ssoUrl: "https://idp/sso", x509cert: "-----BEGIN CERTIFICATE-----\ngarbage\n-----END CERTIFICATE-----" });
    expect(r.ok).toBe(false);
  });
  it("returns ok:false when no cert is configured", async () => {
    const r = await testSamlConnection({ ssoUrl: "https://idp/sso" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no x509");
  });
});

describe("testConnection dispatch", () => {
  const orig = globalThis.fetch;
  afterEach(() => { globalThis.fetch = orig; });
  it("routes oidc to discovery and saml to cert parse", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 })) as typeof fetch;
    expect((await testConnection("oidc", { issuer: "https://8.8.8.8" })).ok).toBe(true);
    expect((await testConnection("saml", { ssoUrl: "https://idp/sso", x509cert: TEST_CERT })).ok).toBe(true);
  });
});

describe("mergeProviderConfig (secret preservation on edit)", () => {
  it("keeps the existing OIDC clientSecret when the incoming value is blank", () => {
    const merged = mergeProviderConfig("oidc",
      { issuer: "https://old", clientId: "cid", clientSecret: "REAL", redirectUri: "https://app/cb" },
      { issuer: "https://new", clientId: "cid", clientSecret: "", redirectUri: "https://app/cb" });
    expect(merged.clientSecret).toBe("REAL");
    expect(merged.issuer).toBe("https://new");
  });

  it("keeps the existing clientSecret when the incoming value is the redaction placeholder", () => {
    const merged = mergeProviderConfig("oidc",
      { clientSecret: "REAL" }, { clientSecret: "***" });
    expect(merged.clientSecret).toBe("REAL");
  });

  it("overwrites the OIDC clientSecret when a new one is supplied", () => {
    const merged = mergeProviderConfig("oidc",
      { clientSecret: "REAL" }, { clientSecret: "ROTATED" });
    expect(merged.clientSecret).toBe("ROTATED");
  });

  it("keeps the existing SAML cert when the incoming value is the truncated placeholder", () => {
    const truncated = TEST_CERT.slice(0, 60) + "…";
    const merged = mergeProviderConfig("saml",
      { x509cert: TEST_CERT, ssoUrl: "https://idp/sso" },
      { x509cert: truncated, ssoUrl: "https://idp/sso" });
    expect(merged.x509cert).toBe(TEST_CERT);
  });
});
