import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, killSwitches, repositories, reviewComments, reviews, sandboxes } from "../models/schema.js";
import { memorySeedCount, quarantineAgentMemories } from "./memory.js";

export async function isAgentKilled(db: DB, agentId: string): Promise<boolean> {
  return !!(await db.select().from(killSwitches).where(eq(killSwitches.agentId, agentId)).limit(1))[0];
}

export async function engage(db: DB, agentId: string, reason: string | null, engagedBy?: string): Promise<void> {
  await db.insert(killSwitches).values({ agentId, reason, engagedBy: engagedBy ?? null })
    .onConflictDoUpdate({ target: killSwitches.agentId, set: { reason, engagedBy: engagedBy ?? null, engagedAt: new Date() } });
  // Also kill any running sandboxes for this agent.
  await db.update(sandboxes).set({ status: "killed", finishedAt: new Date() })
    .where(and(eq(sandboxes.agentId, agentId), eq(sandboxes.status, "running")));
  // Quarantine the shared (repo/org) memories this agent seeded, so a compromised
  // agent's conventions stop reaching other runs immediately. Best-effort.
  await quarantineAgentMemories(db, agentId).catch(() => { /* memory is additive; never block the kill */ });
}

export async function disengage(db: DB, agentId: string): Promise<void> {
  await db.delete(killSwitches).where(eq(killSwitches.agentId, agentId));
}

export interface BlastRadiusReport {
  agentId: string;
  since: Date;
  changesOpened: Array<{ id: string; repoId: string; branch: string; intent: string; status: string; createdAt: Date }>;
  changesMerged: Array<{ id: string; repoId: string; branch: string; intent: string; mergedAt: Date | null; mergeCommit: string | null }>;
  reviewsSubmitted: number;
  commentsAuthored: number;
  memoriesSeeded: number; // shared (repo/org) memories this agent wrote into other scopes
  reposTouched: Array<{ id: string; name: string }>;
}

export async function blastRadius(db: DB, agentId: string, sinceHoursAgo = 24): Promise<BlastRadiusReport> {
  const since = new Date(Date.now() - sinceHoursAgo * 3600 * 1000);

  const opened = await db.select().from(changes).where(and(eq(changes.openedByAgentId, agentId), gte(changes.createdAt, since))).orderBy(desc(changes.createdAt));
  const merged = opened.filter(c => c.status === "merged");

  const reviewsN = await countReviewsByAgentSince(db, agentId, since);

  const comments = await db.select().from(reviewComments)
    .where(and(eq(reviewComments.authorKind, "agent"), eq(reviewComments.authorId, agentId), gte(reviewComments.createdAt, since)));

  const repoIds = Array.from(new Set(opened.map(c => c.repoId)));
  const repos = repoIds.length ? await db.select().from(repositories).where(inArray(repositories.id, repoIds)) : [];
  const memoriesSeeded = await memorySeedCount(db, agentId, since);

  return {
    agentId,
    since,
    changesOpened: opened.map(c => ({ id: c.id, repoId: c.repoId, branch: c.branch, intent: c.intent, status: c.status, createdAt: c.createdAt })),
    changesMerged: merged.map(c => ({ id: c.id, repoId: c.repoId, branch: c.branch, intent: c.intent, mergedAt: c.mergedAt, mergeCommit: c.mergeCommit })),
    reviewsSubmitted: reviewsN,
    commentsAuthored: comments.length,
    memoriesSeeded,
    reposTouched: repos.map(r => ({ id: r.id, name: r.name })),
  };
}

export async function countReviewsByAgentSince(db: DB, agentId: string, since: Date): Promise<number> {
  const rows = await db.select().from(reviews).where(and(eq(reviews.reviewerKind, "agent"), eq(reviews.reviewerId, agentId), gte(reviews.submittedAt, since)));
  return rows.length;
}
