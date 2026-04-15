import { describe, it, expect, beforeAll } from "vitest";
import nacl from "tweetnacl";
import util from "tweetnacl-util";

describe("secrets seal/unseal", () => {
  let seal: (v: string) => { ciphertext: string; nonce: string };
  let unseal: (c: string, n: string) => string;

  beforeAll(async () => {
    process.env.CLAWHUB_SECRETS_KEY = util.encodeBase64(nacl.randomBytes(32));
    const mod = await import("../src/services/secrets.js");
    seal = mod.seal;
    unseal = mod.unseal;
  });

  it("round-trips a secret value", () => {
    const { ciphertext, nonce } = seal("postgres://user:pass@host/db");
    expect(unseal(ciphertext, nonce)).toBe("postgres://user:pass@host/db");
  });

  it("fails to unseal with a tampered nonce", () => {
    const { ciphertext } = seal("hunter2");
    const badNonce = util.encodeBase64(nacl.randomBytes(24));
    expect(() => unseal(ciphertext, badNonce)).toThrow();
  });
});
