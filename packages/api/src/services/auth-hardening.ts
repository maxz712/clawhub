import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailVerifications, loginAttempts, passwordResets, users } from "../models/schema.js";
import { hashPassword } from "./auth.js";
import { queueEmail } from "./notifications.js";
import { emailOutbox } from "../models/schema.js";
import { log } from "./logger.js";

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 8;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function enforceJwtSecret(): void {
  const secret = process.env.JWT_SECRET ?? "";
  const env = process.env.NODE_ENV ?? "";
  if (env === "production" && (!secret || secret === "dev-secret-change-me")) {
    log("error", "jwt_secret_not_set", {});
    throw new Error("CLAWHUB refuses to start in production with an unset/default JWT_SECRET");
  }
  if (env === "production" && secret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 chars in production");
  }
}

export async function recordLoginAttempt(db: DB, email: string, ip: string | null, success: boolean): Promise<void> {
  await db.insert(loginAttempts).values({ email: email.toLowerCase(), ip, success });
}

export async function isLockedOut(db: DB, email: string): Promise<{ locked: boolean; failed: number }> {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MS);
  const rows = await db.select().from(loginAttempts)
    .where(and(eq(loginAttempts.email, email.toLowerCase()), gte(loginAttempts.createdAt, since)))
    .orderBy(desc(loginAttempts.createdAt))
    .limit(LOCKOUT_THRESHOLD + 1);
  // If last N attempts were all failures, lock.
  if (rows.length >= LOCKOUT_THRESHOLD && rows.slice(0, LOCKOUT_THRESHOLD).every(r => !r.success)) {
    return { locked: true, failed: rows.filter(r => !r.success).length };
  }
  return { locked: false, failed: rows.filter(r => !r.success).length };
}

// Email verification — issued on signup, accepted via /api/v1/users/verify-email?token=...
export async function issueEmailVerification(db: DB, userId: string): Promise<string> {
  const raw = randomBytes(24).toString("base64url");
  await db.insert(emailVerifications).values({
    userId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });
  return raw;
}

export async function consumeEmailVerification(db: DB, token: string): Promise<string | null> {
  const h = hashToken(token);
  // Single-use under concurrency (#105, same invariant as verifyAndConsumeTotp):
  // claim the token with ONE conditional UPDATE guarded on the CURRENT row
  // state and trust the affected-row count — never a pre-read snapshot.
  const claimed = await db.update(emailVerifications)
    .set({ verifiedAt: new Date() })
    .where(and(
      eq(emailVerifications.tokenHash, h),
      isNull(emailVerifications.verifiedAt),
      gt(emailVerifications.expiresAt, new Date()),
    ))
    .returning({ userId: emailVerifications.userId });
  return claimed[0]?.userId ?? null;
}

// Password reset.
export async function issuePasswordReset(db: DB, email: string): Promise<{ user: { id: string; email: string } | null; token: string | null }> {
  const user = (await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1))[0];
  if (!user) return { user: null, token: null };
  const raw = randomBytes(24).toString("base64url");
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  return { user: { id: user.id, email: user.email }, token: raw };
}

export async function consumePasswordReset(db: DB, token: string, newPassword: string): Promise<boolean> {
  const h = hashToken(token);
  // Claim the token FIRST with an atomic conditional UPDATE (#105) — of N
  // concurrent redemptions of the same token exactly one sees a claimed row.
  // Spend-before-apply also fails closed: a claimed-but-unapplied token just
  // sends the user back to "request a new reset", never a double redemption.
  const claimed = await db.update(passwordResets)
    .set({ usedAt: new Date() })
    .where(and(
      eq(passwordResets.tokenHash, h),
      isNull(passwordResets.usedAt),
      gt(passwordResets.expiresAt, new Date()),
    ))
    .returning({ userId: passwordResets.userId });
  if (!claimed.length) return false;
  const pwHash = await hashPassword(newPassword);
  // Bumping token_version ends every outstanding session — whoever reset the
  // password (proving email ownership) is the only one left signed in.
  await db.update(users).set({ passwordHash: pwHash, tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, claimed[0].userId));
  return true;
}

// Queue a well-formed transactional email via the outbox.
export async function queueTransactionalEmail(db: DB, toUserId: string, subject: string, body: string): Promise<void> {
  const user = (await db.select().from(users).where(eq(users.id, toUserId)).limit(1))[0];
  if (!user) return;
  await db.insert(emailOutbox).values({ toEmail: user.email, subject, body });
}
