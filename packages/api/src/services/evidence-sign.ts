import { createHmac, timingSafeEqual } from "node:crypto";

// Signed PUBLIC evidence URLs (M9). A reviewer with repo read can mint a short-
// lived, HMAC-signed link to a verification screenshot/log that serves WITHOUT a
// Bearer token — for sharing proof (a GitHub App check, the landing demo, a
// stakeholder) without exposing the private repo. The signature binds the exact
// blob + an expiry; anything else fails closed.

function signKey(): string {
  return process.env.CLAWHUB_EVIDENCE_SIGN_KEY || process.env.JWT_SECRET || "";
}

export interface EvidenceRef { repoId: string; changeId: string; blobId: string; exp: number }

function payload(r: EvidenceRef): string {
  return `${r.repoId}:${r.changeId}:${r.blobId}:${r.exp}`;
}

/** HMAC signature (hex) over the blob ref + expiry. */
export function signEvidence(r: EvidenceRef): string {
  return createHmac("sha256", signKey()).update(payload(r)).digest("hex");
}

/** Constant-time verify + expiry check. False when the key is unset (fail closed). */
export function verifyEvidence(r: EvidenceRef, sig: string): boolean {
  if (!signKey() || !sig) return false;
  if (!Number.isFinite(r.exp) || r.exp * 1000 < Date.now()) return false;
  const expected = signEvidence(r);
  if (sig.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch { return false; }
}

/** Build the public signed URL for an evidence blob, valid for `ttlSec` seconds. */
export function signedEvidenceUrl(base: string, r: Omit<EvidenceRef, "exp">, ttlSec: number, now = Date.now()): { url: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSec));
  const ref = { ...r, exp };
  const sig = signEvidence(ref);
  const url = `${base.replace(/\/+$/, "")}/api/v1/public/evidence/${r.repoId}/${r.changeId}/${r.blobId}?exp=${exp}&sig=${sig}`;
  return { url, expiresAt: new Date(exp * 1000).toISOString() };
}
