import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { scimTokens } from "../models/schema.js";
import { randomToken } from "./auth.js";

/**
 * SCIM credentials and the scope they authorize (#133).
 *
 * The IdP-facing provisioning surface used to authenticate against ONE
 * instance-wide `CLAWHUB_SCIM_TOKEN`, which on a multi-tenant instance handed
 * every enterprise customer's Okta the same credential — so any one customer's
 * IdP could enumerate, rename and delete any other customer's users. A token
 * minted here binds the caller to a single ORG: `routes/scim.ts` filters every
 * read and write to that org's members, and an id outside it 404s.
 *
 * `CLAWHUB_SCIM_TOKEN` is retained for single-tenant self-hosts (where there
 * may be no org at all) and resolves to the explicit INSTANCE scope. It still
 * fails closed when unset.
 */
export type ScimScope =
  /** A per-org token: every operation is confined to this org's members. */
  | { kind: "org"; orgId: string; tokenId: string }
  /** The legacy instance-wide env token (single-tenant self-host). */
  | { kind: "instance"; orgId: null; tokenId: null };

const TOKEN_PREFIX = "chscim_";

export function hashScimToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Constant-time string compare for the legacy env token. Buffer lengths must
 * match before `timingSafeEqual`, which throws on a length mismatch; the length
 * itself is not the secret.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve a presented bearer to the scope it authorizes, or null.
 *
 * Read the env token at CALL time, not module load, so an operator rotating it
 * (and the test suite) doesn't need a restart. An unset/empty env token can
 * never match — the fail-closed behavior the previous implementation had.
 */
export async function resolveScimScope(db: DB, presented: string): Promise<ScimScope | null> {
  if (!presented) return null;

  const envToken = process.env.CLAWHUB_SCIM_TOKEN ?? "";
  if (envToken && timingSafeEqualStr(presented, envToken)) {
    return { kind: "instance", orgId: null, tokenId: null };
  }

  // Per-org tokens are looked up by their sha256 digest — the raw value is
  // never stored, and an equality match on a digest leaks nothing useful about
  // a near-miss the way a prefix comparison on the secret itself would.
  const row = (await db.select({ id: scimTokens.id, orgId: scimTokens.orgId }).from(scimTokens)
    .where(eq(scimTokens.tokenHash, hashScimToken(presented))).limit(1))[0];
  if (!row) return null;
  // Best-effort last-used stamp so an admin can spot a stale credential. Never
  // let a bookkeeping write fail the IdP's request.
  void db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, row.id)).catch(() => {});
  return { kind: "org", orgId: row.orgId, tokenId: row.id };
}

export interface ScimTokenSummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** Mint an org-scoped SCIM token. The raw value is returned ONCE. */
export async function createScimToken(
  db: DB, orgId: string, name: string, createdByUserId: string | null,
): Promise<{ token: string; summary: ScimTokenSummary }> {
  const raw = `${TOKEN_PREFIX}${randomToken(32)}`;
  const [row] = await db.insert(scimTokens).values({
    orgId, name, tokenHash: hashScimToken(raw), createdByUserId,
  }).returning();
  return { token: raw, summary: { id: row.id, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt } };
}

/** Metadata only — the hash never leaves this module. */
export async function listScimTokens(db: DB, orgId: string): Promise<ScimTokenSummary[]> {
  const rows = await db.select({
    id: scimTokens.id, name: scimTokens.name, createdAt: scimTokens.createdAt, lastUsedAt: scimTokens.lastUsedAt,
  }).from(scimTokens).where(eq(scimTokens.orgId, orgId));
  return rows;
}

/** Revoke one of the org's tokens. False when it isn't theirs (or is gone). */
export async function revokeScimToken(db: DB, orgId: string, id: string): Promise<boolean> {
  const deleted = await db.delete(scimTokens)
    .where(and(eq(scimTokens.orgId, orgId), eq(scimTokens.id, id))).returning({ id: scimTokens.id });
  return deleted.length > 0;
}
