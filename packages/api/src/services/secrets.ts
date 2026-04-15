import nacl from "tweetnacl";
import util from "tweetnacl-util";

const KEY_ENV = process.env.CLAWHUB_SECRETS_KEY ?? "";

function loadKey(): Uint8Array {
  if (!KEY_ENV) {
    // Dev fallback — zero key. Not safe in prod; startup warns.
    return new Uint8Array(nacl.secretbox.keyLength);
  }
  const buf = util.decodeBase64(KEY_ENV);
  if (buf.length !== nacl.secretbox.keyLength) {
    throw new Error(`CLAWHUB_SECRETS_KEY must be ${nacl.secretbox.keyLength} bytes base64`);
  }
  return buf;
}

const key = loadKey();

export function seal(plaintext: string): { ciphertext: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(util.decodeUTF8(plaintext), nonce, key);
  return { ciphertext: util.encodeBase64(box), nonce: util.encodeBase64(nonce) };
}

export function unseal(ciphertext: string, nonce: string): string {
  const box = util.decodeBase64(ciphertext);
  const n = util.decodeBase64(nonce);
  const opened = nacl.secretbox.open(box, n, key);
  if (!opened) throw new Error("secret_unseal_failed");
  return util.encodeUTF8(opened);
}

export function isSecretsKeyConfigured(): boolean {
  return !!KEY_ENV;
}
