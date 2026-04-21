import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import {
  agentMessages, auditEvents, costLedger, gdprRequests, issueComments, issues,
  mentions, notificationPrefs, orgMembers, reviews, users,
} from "../models/schema.js";

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
      const bundle = { user: user ? { ...user, passwordHash: "<redacted>", totpSecret: user.totpSecret ? "<redacted>" : null } : null, memberships, prefs, reviews: reviewRows, comments: commentRows, issues: issueRows, audit: auditRows, mentions: mentionRows };
      const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(bundle)).toString("base64")}`;
      await db.update(gdprRequests).set({ status: "ready", downloadUrl: dataUrl, finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    } catch (e) {
      await db.update(gdprRequests).set({ status: "failed", downloadUrl: String((e as Error).message ?? e), finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    }
  })();
  return req.id;
}

export async function requestDeletion(db: DB, userId: string): Promise<string> {
  const [req] = await db.insert(gdprRequests).values({ userId, kind: "delete", status: "pending" }).returning();
  void (async () => {
    try {
      // Hard-delete user account; cascades wipe their personal data.
      // Cost ledger entries etc. tied to agents remain (business records).
      await db.delete(users).where(eq(users.id, userId));
      await db.update(gdprRequests).set({ status: "done", finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    } catch (e) {
      await db.update(gdprRequests).set({ status: "failed", downloadUrl: String((e as Error).message ?? e), finishedAt: new Date() }).where(eq(gdprRequests.id, req.id));
    }
  })();
  return req.id;
}

export async function getRequest(db: DB, id: string, userId: string) {
  return (await db.select().from(gdprRequests).where(and(eq(gdprRequests.id, id), eq(gdprRequests.userId, userId))).limit(1))[0] ?? null;
}
