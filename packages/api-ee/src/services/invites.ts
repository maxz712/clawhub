import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import type { DB } from "@clawhub/api/db";
import { emailOutbox, orgMembers, users } from "@clawhub/api/schema";
import { orgInvites, orgTrials } from "../schema.js";

function hashToken(t: string): string { return createHash("sha256").update(t).digest("hex"); }

export async function startTrial(db: DB, orgId: string, days = 30, plan = "team"): Promise<void> {
  const endsAt = new Date(Date.now() + days * 24 * 3600 * 1000);
  await db.insert(orgTrials).values({ orgId, endsAt, plan }).onConflictDoUpdate({ target: orgTrials.orgId, set: { endsAt, plan } });
}

export async function activeTrial(db: DB, orgId: string) {
  const row = (await db.select().from(orgTrials).where(eq(orgTrials.orgId, orgId)).limit(1))[0];
  if (!row) return null;
  return row.endsAt > new Date() ? row : null;
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
  await db.insert(orgMembers).values({ orgId: row.orgId, userId, role: row.role }).onConflictDoNothing();
  await db.update(orgInvites).set({ acceptedAt: new Date() }).where(eq(orgInvites.id, row.id));
  return { orgId: row.orgId, role: row.role };
}

export async function listInvites(db: DB, orgId: string) {
  return db.select().from(orgInvites).where(eq(orgInvites.orgId, orgId));
}

export async function revokeInvite(db: DB, orgId: string, inviteId: string): Promise<void> {
  await db.delete(orgInvites).where(and(eq(orgInvites.orgId, orgId), eq(orgInvites.id, inviteId)));
}
