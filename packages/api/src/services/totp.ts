import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { isSecretsKeyConfigured, seal, unseal } from "./secrets.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32 (RFC 4648, no 0/1/8/9)

function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

function fromBase32(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateSecret(): string {
  return toBase32(randomBytes(20));
}

export function totpCode(secret: string, at: number = Date.now(), step = 30, digits = 6): string {
  const counter = Math.floor(at / 1000 / step);
  const key = fromBase32(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function verifyTotp(secret: string, code: string, at: number = Date.now(), windowSteps = 1): boolean {
  return verifyTotpStep(secret, code, at, windowSteps) !== null;
}

/**
 * Like verifyTotp but returns the matched step COUNTER (floor(t/step)) so the
 * caller can enforce single-use (reject a code whose step ≤ the last consumed),
 * or null if no code in the window matches.
 */
export function verifyTotpStep(secret: string, code: string, at: number = Date.now(), windowSteps = 1, step = 30): number | null {
  if (!/^\d+$/.test(code)) return null;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const t = at + w * step * 1000;
    if (totpCode(secret, t, step) === code) return Math.floor(t / 1000 / step);
  }
  return null;
}

// Seal a TOTP secret for storage. With no secrets key (dev/test) it falls back to
// plaintext with a null nonce so the flow still works; prod enforces the key at boot.
export function sealTotpSecret(plain: string): { secret: string; nonce: string | null } {
  if (!isSecretsKeyConfigured()) return { secret: plain, nonce: null };
  const { ciphertext, nonce } = seal(plain);
  return { secret: ciphertext, nonce };
}
// Open a stored TOTP secret. A null nonce means legacy plaintext.
export function openTotpSecret(stored: string, nonce: string | null): string {
  return nonce ? unseal(stored, nonce) : stored;
}

type TotpUserRow = { id: string; totpSecret: string | null; totpSecretNonce: string | null; totpLastStep: number | null };

/**
 * Verify a code AND enforce single-use within its window by persisting the
 * last-consumed step counter. Returns true only for a valid code that hasn't
 * been used (step > last). Unseals the stored secret first.
 */
export async function verifyAndConsumeTotp(db: DB, user: TotpUserRow, code: string, at: number = Date.now()): Promise<boolean> {
  if (!user.totpSecret) return false;
  let secret: string;
  try { secret = openTotpSecret(user.totpSecret, user.totpSecretNonce); } catch { return false; }
  const step = verifyTotpStep(secret, code, at);
  if (step === null) return false;
  const last = user.totpLastStep == null ? -1 : Number(user.totpLastStep);
  if (step <= last) return false; // replay: same or older code already consumed
  // Atomic consume. The passed-in row may be stale (SELECTed before other logins
  // ran), so correctness cannot come from the in-memory `last` above — that check
  // is only a cheap early-out. Claim the step with a conditional UPDATE guarded
  // on the row's CURRENT value: of N concurrent requests carrying the same code,
  // exactly one updates a row; the rest see zero rows and are rejected as replays.
  const claimed = await db.update(users)
    .set({ totpLastStep: step })
    .where(and(
      eq(users.id, user.id),
      or(isNull(users.totpLastStep), lt(users.totpLastStep, step)),
    ))
    .returning({ id: users.id });
  return claimed.length === 1;
}

export function otpauthUrl(label: string, issuer: string, secret: string): string {
  const enc = (s: string) => encodeURIComponent(s);
  return `otpauth://totp/${enc(issuer)}:${enc(label)}?secret=${secret}&issuer=${enc(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
