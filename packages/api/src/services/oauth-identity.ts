import { and, eq, isNotNull } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailVerifications, userIdentities, users } from "../models/schema.js";
import { hashPassword, randomToken } from "./auth.js";
import { log } from "./logger.js";
import { ensurePersonalAgentInBackground } from "./personal-agent.js";

/**
 * Account resolution for OAuth sign-ins. The contract callers rely on:
 * one email address — across GitHub, Google, and password sign-up — is one
 * ClawHub account.
 *
 * Resolution order:
 *  1. (provider, providerUserId) link — stable even if the user changes
 *     their email at the provider.
 *  2. Email match (normalized) — links this provider to the existing
 *     account. Safe because providers only hand us verified addresses
 *     (`fetchIdentity` returns null otherwise).
 *  3. Create a fresh account.
 *
 * Pre-registration takeover guard: when an OAuth sign-in links into a
 * password-only account whose address was never verified, the password is
 * rotated to a random value. Otherwise someone could register with an email
 * they don't own and quietly keep password access after the real owner
 * signs in via OAuth. The legitimate-password-owner case recovers through
 * the reset flow, which proves email ownership.
 */
export interface OAuthIdentity {
  provider: string;
  providerUserId: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export type ResolvedUser = typeof users.$inferSelect;

export async function resolveOAuthUser(db: DB, ident: OAuthIdentity): Promise<{ user: ResolvedUser; created: boolean }> {
  const email = ident.email.trim().toLowerCase();

  const link = (await db.select().from(userIdentities).where(and(
    eq(userIdentities.provider, ident.provider),
    eq(userIdentities.providerUserId, ident.providerUserId),
  )).limit(1))[0];
  if (link) {
    const user = (await db.select().from(users).where(eq(users.id, link.userId)).limit(1))[0];
    if (user) return { user, created: false };
  }

  let user = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  let created = false;
  if (!user) {
    // OAuth-only account: unguessable password; password login stays
    // possible later via the reset flow.
    const passwordHash = await hashPassword(randomToken(24));
    user = (await db.insert(users).values({
      email,
      name: ident.name,
      avatarUrl: ident.avatarUrl,
      passwordHash,
    }).returning())[0];
    created = true;
    log("info", "oauth_user_created", { provider: ident.provider, userId: user.id });
    // v3: OAuth-created users get the same dormant default personal agent as
    // password registrations (Developer role, no deployment, zero spend).
    ensurePersonalAgentInBackground(db, user.id, email);
  } else {
    const verified = (await db.select({ id: emailVerifications.id }).from(emailVerifications).where(and(
      eq(emailVerifications.userId, user.id),
      isNotNull(emailVerifications.verifiedAt),
    )).limit(1))[0];
    const otherIdentity = (await db.select({ id: userIdentities.id }).from(userIdentities)
      .where(eq(userIdentities.userId, user.id)).limit(1))[0];
    if (!verified && !otherIdentity) {
      await db.update(users).set({ passwordHash: await hashPassword(randomToken(24)) }).where(eq(users.id, user.id));
      log("warn", "oauth_link_rotated_unverified_password", { provider: ident.provider, userId: user.id });
    }
    log("info", "oauth_identity_linked", { provider: ident.provider, userId: user.id });
  }

  await db.insert(userIdentities).values({
    userId: user.id,
    provider: ident.provider,
    providerUserId: ident.providerUserId,
    email,
  }).onConflictDoNothing();

  // Record provider attestation of the address. expiresAt in the past keeps
  // the row inert for the token-consume path; verifiedAt is what the
  // takeover guard reads.
  await db.insert(emailVerifications).values({
    userId: user.id,
    tokenHash: `oauth:${ident.provider}`,
    expiresAt: new Date(0),
    verifiedAt: new Date(),
  });

  return { user, created };
}
