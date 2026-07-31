import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import {
  agentMemories, agentMessages, agents, auditEvents, costLedger, gdprRequests, issueComments, issues,
  mentions, notificationPrefs, orgMembers, platformUsage, reviews, users,
} from "../models/schema.js";
import { verifyPassword } from "./auth.js";
import { queueTransactionalEmail } from "./auth-hardening.js";
import { AuthError, NotFoundError } from "./errors.js";

const DELETE_CONFIRM_TTL_MS = 30 * 60 * 1000;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function requestExport(db: DB, userId: string): Promise<string> {
  const [req] = await db.insert(gdprRequests).values({ userId, kind: "export", status: "pending" }).returning();
  // Run asynchronously but keep it lightweight — build a JSON bundle.
  void (async () => {
    try {
      const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
      const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
      const prefs = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId));
      const reviewRows = await db.select().from(reviews).where(and(eq(reviews.reviewerKind, "human"), eq(reviews.reviewerId, userId)));
      const commentRows = await db.select().from(issueComments).where(and(eq(issueComments.authorKind, "human"), eq(issueComments.authorId, userId)));
      const issueRows = await db.select().from(issues).where(and(eq(issues.createdByKind, "human"), eq(issues.createdById, userId)));
      const auditRows = await db.select().from(auditEvents).where(and(eq(auditEvents.actorKind, "human"), eq(auditEvents.actorId, userId)));
      const mentionRows = await db.select().from(mentions).where(and(eq(mentions.mentionedKind, "human"), eq(mentions.mentionedId, userId)));
      // Platform-LLM usage attributed to this user (M3) — token counts + cost.
      const platformUsageRows = await db.select().from(platformUsage).where(eq(platformUsage.userId, userId));
      const bundle = { user: user ? { ...user, passwordHash: "<redacted>", totpSecret: user.totpSecret ? "<redacted>" : null } : null, memberships, prefs, reviews: reviewRows, comments: commentRows, issues: issueRows, audit: auditRows, mentions: mentionRows, platformUsage: platformUsageRows };
      const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(bundle)).toString("base64")}`;
      await db.update(gdprRequests).set({ status: "ready", downloadUrl: dataUrl, finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    } catch (e) {
      await db.update(gdprRequests).set({ status: "failed", downloadUrl: String((e as Error).message ?? e), finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    }
  })();
  return req.id;
}

// Re-auth gate shared by DELETE /api/v1/account and POST /api/v1/gdpr/delete
// (#103): a stolen bearer token alone must never reach the deletion cascade.
// OAuth-only accounts carry an unguessable random hash, so verifyPassword can
// never pass for them — they go through the email-confirmation path instead.
export async function requirePasswordReauth(db: DB, userId: string, password: string): Promise<void> {
  const u = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!u) throw new NotFoundError("user");
  if (!u.passwordHash || !(await verifyPassword(password, u.passwordHash))) {
    throw new AuthError("wrong password");
  }
}

// The ONE deletion cascade. Runs detached; the gdpr_requests row records the
// outcome. Callers must have already cleared a re-auth gate (password or
// emailed confirmation token) — never invoke it off a bare bearer token.
function executeDeletion(db: DB, requestId: string, userId: string): void {
  void (async () => {
    try {
      // Notify the account address BEFORE the row disappears (the outbox keys
      // on the email string, not a user FK) — a hijacked-account deletion must
      // at least be visible to the owner.
      await queueTransactionalEmail(db, userId, "Your ClawHub account has been deleted",
        "<p>Your ClawHub account and associated personal data have been permanently deleted, as requested.</p><p>If you did not request this, contact support immediately — your credentials may be compromised.</p>");
      // Purge memories authored by this user's agents before deleting the account.
      // createdByAgentId is set-null on agent delete, so these wouldn't cascade —
      // delete them explicitly while the agent→user link still resolves.
      const userAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.associatedUserId, userId));
      if (userAgents.length) await db.delete(agentMemories).where(inArray(agentMemories.createdByAgentId, userAgents.map(a => a.id)));
      // Platform-usage billing records (M3): SCRUB the personal attribution but
      // RETAIN the amounts (token counts + cost) as financial records — the
      // retention basis is stated in the privacy policy. The FK is SET NULL so
      // the account delete would do this anyway; we null it explicitly so the
      // intent is unmistakable and independent of FK behavior.
      await db.update(platformUsage).set({ userId: null }).where(eq(platformUsage.userId, userId));
      // Audit rows (v3 unified audit): SCRUB attribution, RETAIN events.
      // auditEvents.actorId is a bare uuid (no FK), so nothing cascades —
      // clear both the id and the denormalized handle explicitly.
      await db.update(auditEvents)
        .set({ actorId: null, actorHandle: null })
        .where(and(eq(auditEvents.actorKind, "human"), eq(auditEvents.actorId, userId)));
      // Hard-delete user account; cascades wipe their personal data.
      // Cost ledger entries etc. tied to agents remain (business records).
      await db.delete(users).where(eq(users.id, userId));
      await db.update(gdprRequests).set({ status: "done", finishedAt: new Date() }).where(eq(gdprRequests.id, requestId));
    } catch (e) {
      await db.update(gdprRequests).set({ status: "failed", downloadUrl: String((e as Error).message ?? e), finishedAt: new Date() }).where(eq(gdprRequests.id, requestId));
    }
  })();
}

export async function requestDeletion(db: DB, userId: string): Promise<string> {
  const [req] = await db.insert(gdprRequests).values({ userId, kind: "delete", status: "pending" }).returning();
  executeDeletion(db, req.id, userId);
  return req.id;
}

// Email-confirmation path for accounts that cannot supply a password (#103):
// issue a single-use, sha256-hashed-at-rest, TTL'd token; NOTHING is deleted
// until confirmDeletion consumes it. The auth-hardening password-reset flow is
// the template.
export async function issueDeletionConfirmation(db: DB, userId: string): Promise<{ requestId: string; token: string }> {
  const raw = randomBytes(24).toString("base64url");
  const [req] = await db.insert(gdprRequests).values({
    userId,
    kind: "delete",
    status: "awaiting_confirm",
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + DELETE_CONFIRM_TTL_MS),
  }).returning();
  return { requestId: req.id, token: raw };
}

// Consume the emailed token and run the cascade. The claim is a CONDITIONAL
// UPDATE (status awaiting_confirm → pending, unexpired) so two concurrent
// consumes race on the row lock and exactly one wins — the #99 TOTP lesson,
// no read-check-write. Expired/reused/tampered tokens fall through to null.
export async function confirmDeletion(db: DB, token: string): Promise<string | null> {
  if (!token) return null;
  const [row] = await db.update(gdprRequests)
    .set({ status: "pending", tokenHash: null })
    .where(and(
      eq(gdprRequests.tokenHash, hashToken(token)),
      eq(gdprRequests.status, "awaiting_confirm"),
      gt(gdprRequests.expiresAt, new Date()),
    ))
    .returning();
  if (!row) return null;
  executeDeletion(db, row.id, row.userId);
  return row.id;
}

export async function getRequest(db: DB, id: string, userId: string) {
  return (await db.select().from(gdprRequests).where(and(eq(gdprRequests.id, id), eq(gdprRequests.userId, userId))).limit(1))[0] ?? null;
}
