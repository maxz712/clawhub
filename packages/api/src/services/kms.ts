import { createHmac, randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { log } from "./logger.js";

export interface KeyProvider {
  // Envelope-encrypt a data key. Returns an opaque ciphertext blob.
  encryptDek(dek: Uint8Array): Promise<{ ciphertext: string; keyId: string }>;
  decryptDek(ciphertext: string): Promise<Uint8Array>;
  // Sign arbitrary bytes with the active signing key.
  sign(bytes: Uint8Array): Promise<{ signature: string; keyId: string }>;
  verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean>;
}

/**
 * Local: uses the process-level CLAWHUB_SECRETS_KEY for envelope, and an
 * in-memory Ed25519 keypair for signing. Prefer `AwsKmsProvider` in prod.
 */
export class LocalKeyProvider implements KeyProvider {
  private ed = nacl.sign.keyPair();
  constructor(private masterKey: Uint8Array) {}

  async encryptDek(dek: Uint8Array): Promise<{ ciphertext: string; keyId: string }> {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const box = nacl.secretbox(dek, nonce, this.masterKey);
    return {
      ciphertext: util.encodeBase64(nonce) + "." + util.encodeBase64(box),
      keyId: "local:master",
    };
  }

  async decryptDek(ciphertext: string): Promise<Uint8Array> {
    const [nonceB64, boxB64] = ciphertext.split(".");
    const opened = nacl.secretbox.open(util.decodeBase64(boxB64), util.decodeBase64(nonceB64), this.masterKey);
    if (!opened) throw new Error("kms_unseal_failed");
    return opened;
  }

  async sign(bytes: Uint8Array): Promise<{ signature: string; keyId: string }> {
    const sig = nacl.sign.detached(bytes, this.ed.secretKey);
    return { signature: util.encodeBase64(sig), keyId: "local:ed25519" };
  }

  async verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean> {
    if (keyId !== "local:ed25519") return false;
    try { return nacl.sign.detached.verify(bytes, util.decodeBase64(signature), this.ed.publicKey); }
    catch { return false; }
  }
}

/**
 * AWS KMS via SigV4 + REST. This calls the AWS KMS HTTP API directly — no
 * SDK dep. Envelope uses `GenerateDataKey` / `Decrypt`; signing uses `Sign`.
 * Operators configure via AWS_KMS_KEY_ID + standard AWS creds.
 */
export interface AwsKmsConfig { region: string; keyId: string; accessKeyId: string; secretAccessKey: string }

export class AwsKmsProvider implements KeyProvider {
  constructor(private cfg: AwsKmsConfig) {}

  async encryptDek(dek: Uint8Array): Promise<{ ciphertext: string; keyId: string }> {
    const res = await this.call("Encrypt", { KeyId: this.cfg.keyId, Plaintext: Buffer.from(dek).toString("base64") });
    return { ciphertext: String(res.CiphertextBlob), keyId: String(res.KeyId ?? this.cfg.keyId) };
  }

  async decryptDek(ciphertext: string): Promise<Uint8Array> {
    const res = await this.call("Decrypt", { CiphertextBlob: ciphertext });
    return Buffer.from(String(res.Plaintext), "base64");
  }

  async sign(bytes: Uint8Array): Promise<{ signature: string; keyId: string }> {
    const res = await this.call("Sign", {
      KeyId: this.cfg.keyId,
      Message: Buffer.from(bytes).toString("base64"),
      MessageType: "RAW",
      SigningAlgorithm: "ECDSA_SHA_256",
    });
    return { signature: String(res.Signature), keyId: String(res.KeyId ?? this.cfg.keyId) };
  }

  async verify(bytes: Uint8Array, signature: string, keyId: string): Promise<boolean> {
    try {
      const res = await this.call("Verify", {
        KeyId: keyId, Message: Buffer.from(bytes).toString("base64"),
        MessageType: "RAW", Signature: signature, SigningAlgorithm: "ECDSA_SHA_256",
      });
      return res.SignatureValid === true;
    } catch { return false; }
  }

  private async call(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const host = `kms.${this.cfg.region}.amazonaws.com`;
    const payload = JSON.stringify(body);
    const { createHash } = await import("node:crypto");
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const target = `TrentService.${action}`;
    const canonical = [
      "POST", "/", "",
      `content-type:application/x-amz-json-1.1\nhost:${host}\nx-amz-date:${amzDate}\nx-amz-target:${target}\n`,
      "content-type;host;x-amz-date;x-amz-target", payloadHash,
    ].join("\n");
    const scope = `${date}/${this.cfg.region}/kms/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const kDate = createHmac("sha256", "AWS4" + this.cfg.secretAccessKey).update(date).digest();
    const kRegion = createHmac("sha256", kDate).update(this.cfg.region).digest();
    const kService = createHmac("sha256", kRegion).update("kms").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const res = await fetch(`https://${host}/`, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": target,
        "x-amz-date": amzDate,
        host,
        authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=${signature}`,
      },
      body: payload,
    });
    if (!res.ok) throw new Error(`kms_${action}_${res.status}:${await res.text()}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

let cached: KeyProvider | null = null;
export function buildKeyProviderFromEnv(): KeyProvider {
  if (cached) return cached;
  if (process.env.AWS_KMS_KEY_ID && process.env.AWS_ACCESS_KEY_ID) {
    cached = new AwsKmsProvider({
      region: process.env.AWS_REGION ?? "us-east-1",
      keyId: process.env.AWS_KMS_KEY_ID,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    });
    log("info", "kms_provider", { kind: "aws" });
    return cached;
  }
  const keyEnv = process.env.CLAWHUB_SECRETS_KEY ?? "";
  const key = keyEnv ? util.decodeBase64(keyEnv) : new Uint8Array(nacl.secretbox.keyLength);
  cached = new LocalKeyProvider(key);
  log("info", "kms_provider", { kind: "local" });
  return cached;
}
