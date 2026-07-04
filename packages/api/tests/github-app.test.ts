import { describe, it, expect, afterEach } from "vitest";
import { generateKeyPairSync, createVerify, createHmac } from "node:crypto";
import { appJwt, verifyWebhookSignature, githubAppConfig } from "../src/services/github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("github-app auth core", () => {
  it("signs a verifiable RS256 App JWT with iss=appId and a bounded exp", () => {
    const now = 1_700_000_000;
    const jwt = appJwt({ appId: "4217155", privateKey: pem, webhookSecret: "" }, now);
    const [h, p, sig] = jwt.split(".");
    expect(sig).toBeTruthy();
    // signature verifies against the public key
    const v = createVerify("RSA-SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload.iss).toBe("4217155");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600); // GitHub caps at 10m
  });

  it("verifies a webhook signature timing-safely; rejects wrong/missing", () => {
    const secret = "whsec_test";
    const body = JSON.stringify({ action: "opened" });
    const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyWebhookSignature(body, good, secret)).toBe(true);
    expect(verifyWebhookSignature(body, good, "other")).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=deadbeef", secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, good, "")).toBe(false);
  });

  it("parses a PEM delivered via escaped \\n", () => {
    process.env.GITHUB_APP_ID = "4217155";
    process.env.GITHUB_APP_PRIVATE_KEY = pem.replace(/\n/g, "\\n");
    const cfg = githubAppConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.privateKey).toContain("BEGIN");
    // and the resulting key actually signs
    expect(appJwt(cfg!).split(".").length).toBe(3);
  });

  it("parses a PEM delivered base64-encoded", () => {
    process.env.GITHUB_APP_ID = "4217155";
    process.env.GITHUB_APP_PRIVATE_KEY = Buffer.from(pem).toString("base64");
    const cfg = githubAppConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.privateKey).toContain("BEGIN");
  });

  it("returns null (feature off) when unconfigured", () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(githubAppConfig()).toBeNull();
  });
});
