import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailOutbox, notificationPrefs, users, type NotificationPref } from "../models/schema.js";

const DEFAULT_PREFS: Omit<NotificationPref, "id" | "userId" | "updatedAt"> = {
  email: true,
  emailOnMention: true,
  emailOnReviewRequested: true,
  emailOnChangeMerged: true,
  emailOnCiFailure: true,
  digestFrequency: "never",
};

export async function getPrefs(db: DB, userId: string): Promise<NotificationPref> {
  const row = (await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).limit(1))[0];
  if (row) return row;
  const [inserted] = await db.insert(notificationPrefs).values({ userId, ...DEFAULT_PREFS }).returning();
  return inserted;
}

export async function updatePrefs(db: DB, userId: string, patch: Partial<Omit<NotificationPref, "id" | "userId" | "updatedAt">>): Promise<NotificationPref> {
  const existing = await getPrefs(db, userId);
  const [updated] = await db.update(notificationPrefs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(notificationPrefs.id, existing.id))
    .returning();
  return updated;
}

export async function queueEmail(db: DB, toUserId: string, subject: string, body: string, kind: keyof Omit<NotificationPref, "id" | "userId" | "updatedAt" | "email" | "digestFrequency">): Promise<void> {
  const prefs = await getPrefs(db, toUserId);
  if (!prefs.email) return;
  if (kind && prefs[kind] === false) return;

  const user = (await db.select().from(users).where(eq(users.id, toUserId)).limit(1))[0];
  if (!user) return;

  await db.insert(emailOutbox).values({
    toEmail: user.email,
    subject,
    body,
    status: "pending",
  });
}

export async function markDelivered(db: DB, id: string, ok: boolean, error?: string): Promise<void> {
  await db.update(emailOutbox)
    .set({
      status: ok ? "sent" : "failed",
      sentAt: ok ? new Date() : null,
      error: ok ? null : error ?? null,
    })
    .where(eq(emailOutbox.id, id));
}
