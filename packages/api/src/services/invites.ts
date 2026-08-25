import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailOutbox, orgInvites, orgMembers, orgTrials, users } from "../models/schema.js";
import { ConflictError } from "./errors.js";

function hashToken(t: string): string { return createHash("sha256").update(t).digest("hex"); }

export async function startTrial(db: DB, orgId: string, days = 30, plan = "team"): Promise<void> {
  const endsAt = new Date(Date.now() + days * 24 * 3600 * 1000);
  // A trial is strictly once per org (#110). Insert-only: never overwrite an
  // existing row's endsAt/plan, or an org admin could re-call this endpoint on
  // a cron and hold the paid tier forever. onConflictDoNothing + returning()
  // makes the guard race-safe — of two concurrent starts exactly one inserts.
  const inserted = await db.insert(orgTrials).values({ orgId, endsAt, plan })
    .onConflictDoNothing({ target: orgTrials.orgId }).returning({ id: orgTrials.id });
  if (inserted.length === 0) throw new ConflictError("this org's free trial has already been used", "trial_already_used");
}

export async function activeTrial(db: DB, orgId: string) {
  const row = (await db.select().from(orgTrials).where(eq(orgTrials.orgId, orgId)).limit(1))[0];
  if (!row) return null;
  return row.endsAt > new Date() ? row : null;
}

/** Whether the org has ever consumed its one free trial (row exists, active or expired). */
export async function trialUsed(db: DB, orgId: string): Promise<boolean> {
  const row = (await db.select({ id: orgTrials.id }).from(orgTrials).where(eq(orgTrials.orgId, orgId)).limit(1))[0];
  return !!row;
}

export async function createInvite(db: DB, input: { orgId: string; email: string; role?: "admin" | "member"; invitedBy: string; publicBaseUrl: string }): Promise<{ inviteId: string; url: string }> {
  const token = randomBytes(24).toString("base64url");
  const [row] = await db.insert(orgInvites).values({
    orgId: input.orgId,
    email: input.email,
    role: input.role ?? "member",
    tokenHash: hashToken(token),
    invitedBy: input.invitedBy,
    expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
  }).returning();

  const url = `${input.publicBaseUrl.replace(/\/+$/, "")}/invite/${token}`;
  await db.insert(emailOutbox).values({
    toEmail: input.email,
    subject: `You're invited to ClawHub`,
    body: `<p>You've been invited to join an organization on ClawHub.</p><p><a href="${url}">Accept invite</a></p>`,
  });
  return { inviteId: row.id, url };
}

export async function acceptInvite(db: DB, token: string, userId: string): Promise<{ orgId: string; role: "admin" | "member" } | null> {
  const h = hashToken(token);
  const row = (await db.select().from(orgInvites).where(and(eq(orgInvites.tokenHash, h), gt(orgInvites.expiresAt, new Date()))).limit(1))[0];
  if (!row || row.acceptedAt) return null;
  // If the user's email doesn't match the invite, reject.
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user || user.email.toLowerCase() !== row.email.toLowerCase()) return null;
  // invite_accepted: the invitee accepted with their OWN session + a matching
  // email — the consent an SSO resolver may trust (#153).
  await db.insert(orgMembers).values({ orgId: row.orgId, userId, role: row.role, source: "invite_accepted" }).onConflictDoNothing();
  await db.update(orgInvites).set({ acceptedAt: new Date() }).where(eq(orgInvites.id, row.id));
  return { orgId: row.orgId, role: row.role };
}

export async function listInvites(db: DB, orgId: string) {
  return db.select().from(orgInvites).where(eq(orgInvites.orgId, orgId));
}

export async function revokeInvite(db: DB, orgId: string, inviteId: string): Promise<void> {
  await db.delete(orgInvites).where(and(eq(orgInvites.orgId, orgId), eq(orgInvites.id, inviteId)));
}
