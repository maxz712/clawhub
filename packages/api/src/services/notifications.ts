import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailOutbox, notificationPrefs, notifications, users, type Notification, type NotificationPref } from "../models/schema.js";

const DEFAULT_PREFS: Omit<NotificationPref, "id" | "userId" | "updatedAt"> = {
  email: true,
  emailOnMention: true,
  emailOnReviewRequested: true,
  emailOnChangeMerged: true,
  emailOnChangeRolledBack: true,
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

// ── Durable in-app notification inbox (the Bell feed) ─────────────────────────

export interface NewNotification {
  userId: string;
  kind: string; // mention | review_requested | change_merged | change_rolled_back | ci_failure
  title: string;
  body?: string | null;
  link?: string | null;
  repoId?: string | null;
  sourceKind?: string | null;
  sourceId?: string | null;
  actorKind?: "agent" | "human" | "system" | null;
  actorId?: string | null;
}

/** Write a durable notification row for a human user's inbox. */
export async function createNotification(db: DB, n: NewNotification): Promise<void> {
  await db.insert(notifications).values({
    userId: n.userId,
    kind: n.kind,
    title: n.title,
    body: n.body ?? null,
    link: n.link ?? null,
    repoId: n.repoId ?? null,
    sourceKind: n.sourceKind ?? null,
    sourceId: n.sourceId ?? null,
    actorKind: n.actorKind ?? null,
    actorId: n.actorId ?? null,
  });
}

export async function listNotifications(db: DB, userId: string, opts: { unread?: boolean; limit?: number } = {}): Promise<Notification[]> {
  const conds = [eq(notifications.userId, userId)];
  if (opts.unread) conds.push(eq(notifications.read, false));
  return db.select().from(notifications).where(and(...conds)).orderBy(desc(notifications.createdAt)).limit(opts.limit ?? 100);
}

export async function unreadNotificationCount(db: DB, userId: string): Promise<number> {
  const r = await db.select({ c: sql<number>`count(*)::int` }).from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
  return Number(r[0]?.c ?? 0);
}

export async function markNotificationsRead(db: DB, userId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.update(notifications).set({ read: true })
    .where(and(eq(notifications.userId, userId), inArray(notifications.id, ids)));
}

export async function markAllNotificationsRead(db: DB, userId: string): Promise<void> {
  await db.update(notifications).set({ read: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)));
}

/**
 * Deliver @-mention signals to HUMAN recipients: a durable inbox notification
 * PLUS an email (gated by their emailOnMention pref). Agents are NOT emailed/
 * inboxed here — they pull mentions via GET /notifications/mentions. The author
 * is never notified of mentioning themselves. `mentioned` is the resolved return
 * of resolveAndRecordMentions; `link` is a precomputed dashboard deep link so the
 * inbox row addresses the exact source.
 */
export interface DeliverMentionsCtx {
  repoId?: string | null;
  repoFullName: string;
  link: string;
  sourceKind: string;
  sourceId: string;
  snippet?: string | null;
  actor: { kind: "agent" | "human"; id: string };
}
export async function deliverMentions(
  db: DB,
  mentioned: Array<{ kind: "agent" | "human"; id: string; name: string }>,
  ctx: DeliverMentionsCtx,
): Promise<void> {
  for (const m of mentioned) {
    if (m.kind !== "human") continue;
    if (ctx.actor.kind === "human" && ctx.actor.id === m.id) continue; // don't notify your own mention
    const title = `You were mentioned in ${ctx.repoFullName}`;
    const body = ctx.snippet ? ctx.snippet.slice(0, 280) : null;
    await createNotification(db, {
      userId: m.id, kind: "mention", title, body, link: ctx.link,
      repoId: ctx.repoId ?? null, sourceKind: ctx.sourceKind, sourceId: ctx.sourceId,
      actorKind: ctx.actor.kind, actorId: ctx.actor.id,
    });
    await queueEmail(db, m.id, title, `${body ?? ""}\n\nView: ${ctx.link}`.trim(), "emailOnMention");
  }
}

/**
 * Deliver a "your change was merged" signal to the human who opened the change
 * — or, for an agent-opened change, the sponsoring human (`onBehalfOfUserId`,
 * git author-vs-committer style) — as a durable inbox notification PLUS an
 * email (gated by `emailOnChangeMerged`, defaults on). Never notifies someone
 * about their own merge action. Exported standalone (mirroring
 * `deliverMentions`) so it's unit-testable without exercising the full git
 * merge path, which `ChangeService.merge()` otherwise requires.
 */
export interface ChangeMergedNotifyCtx {
  changeId: string;
  repoId: string;
  repoFullName: string;
  link: string;
  intent: string | null;
  openedByUserId: string | null;
  onBehalfOfUserId: string | null;
  by: { kind: "agent" | "human"; id: string };
}
export async function notifyChangeMerged(db: DB, ctx: ChangeMergedNotifyCtx): Promise<void> {
  const recipientId = ctx.openedByUserId ?? ctx.onBehalfOfUserId;
  if (!recipientId || (ctx.by.kind === "human" && ctx.by.id === recipientId)) return;
  const title = `Your change was merged in ${ctx.repoFullName}`;
  const body = ctx.intent || null;
  await createNotification(db, {
    userId: recipientId, kind: "change_merged", title, body, link: ctx.link,
    repoId: ctx.repoId, sourceKind: "change", sourceId: ctx.changeId,
    actorKind: ctx.by.kind, actorId: ctx.by.id,
  });
  await queueEmail(db, recipientId, title, `${body ?? ""}\n\nView: ${ctx.link}`.trim(), "emailOnChangeMerged");
}

/**
 * Deliver a "your merged change was rolled back" signal to the human who
 * opened the change — or, for an agent-opened change, the sponsoring human
 * (`onBehalfOfUserId`) — as a durable inbox notification PLUS an email
 * (gated by `emailOnChangeRolledBack`, defaults on, independent of
 * `emailOnChangeMerged`). Never notifies someone about their own rollback.
 * Mirrors `notifyChangeMerged`; the mirror-image negative-outcome signal.
 */
export interface ChangeRolledBackNotifyCtx {
  changeId: string;
  repoId: string;
  repoFullName: string;
  link: string;
  intent: string | null;
  reason?: string | null;
  openedByUserId: string | null;
  onBehalfOfUserId: string | null;
  by: { kind: "agent" | "human"; id: string };
}
export async function notifyChangeRolledBack(db: DB, ctx: ChangeRolledBackNotifyCtx): Promise<void> {
  const recipientId = ctx.openedByUserId ?? ctx.onBehalfOfUserId;
  if (!recipientId || (ctx.by.kind === "human" && ctx.by.id === recipientId)) return;
  const title = `Your merged change was rolled back in ${ctx.repoFullName}`;
  const body = ctx.reason || ctx.intent || null;
  await createNotification(db, {
    userId: recipientId, kind: "change_rolled_back", title, body, link: ctx.link,
    repoId: ctx.repoId, sourceKind: "change", sourceId: ctx.changeId,
    actorKind: ctx.by.kind, actorId: ctx.by.id,
  });
  await queueEmail(db, recipientId, title, `${body ?? ""}\n\nView: ${ctx.link}`.trim(), "emailOnChangeRolledBack");
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
