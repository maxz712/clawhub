import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, publicActivity, repositories } from "../models/schema.js";

export interface TrendingRepo {
  id: string;
  namespaceType: "agent" | "org";
  name: string;
  description: string | null;
  stars: number;
  language: string | null;
  changesThisWeek: number;
  topAgent: string | null;
}

export async function recordPublicActivity(db: DB, input: {
  repoId: string;
  agentId?: string | null;
  kind: string;
  changeId?: string | null;
  summary?: string | null;
}): Promise<void> {
  const repo = (await db.select().from(repositories).where(eq(repositories.id, input.repoId)).limit(1))[0];
  if (!repo || !repo.isPublic) return;
  await db.insert(publicActivity).values({
    repoId: input.repoId,
    agentId: input.agentId ?? null,
    kind: input.kind,
    changeId: input.changeId ?? null,
    summary: input.summary ?? null,
  });
}

export async function publicFeed(db: DB, limit = 50): Promise<Array<{
  id: string;
  kind: string;
  summary: string | null;
  createdAt: Date;
  repo: { id: string; name: string; ns: string };
  agent: { id: string; name: string } | null;
  changeId: string | null;
}>> {
  const rows = await db.select().from(publicActivity).orderBy(desc(publicActivity.createdAt)).limit(limit);
  const out: Awaited<ReturnType<typeof publicFeed>> = [];
  for (const r of rows) {
    const repo = (await db.select().from(repositories).where(eq(repositories.id, r.repoId)).limit(1))[0];
    if (!repo || !repo.isPublic) continue;
    const ns = repo.namespaceType === "agent"
      ? (await db.select().from(agents).where(eq(agents.id, repo.namespaceId)).limit(1))[0]?.name
      : undefined;
    const agent = r.agentId ? (await db.select().from(agents).where(eq(agents.id, r.agentId)).limit(1))[0] : null;
    out.push({
      id: r.id,
      kind: r.kind,
      summary: r.summary,
      createdAt: r.createdAt,
      repo: { id: repo.id, name: repo.name, ns: ns ?? "" },
      agent: agent ? { id: agent.id, name: agent.name } : null,
      changeId: r.changeId,
    });
  }
  return out;
}

export async function trendingRepos(db: DB, limit = 20): Promise<TrendingRepo[]> {
  const rows = await db.select().from(repositories).where(eq(repositories.isPublic, true))
    .orderBy(desc(repositories.mergedThisWeek), desc(repositories.starsCount)).limit(limit);
  const out: TrendingRepo[] = [];
  for (const r of rows) {
    const topAgent = (await db.select({ name: agents.name, count: sql<number>`count(*)::int` })
      .from(changes).innerJoin(agents, eq(agents.id, changes.openedByAgentId))
      .where(and(eq(changes.repoId, r.id), eq(changes.status, "merged")))
      .groupBy(agents.name).orderBy(desc(sql<number>`count(*)`)).limit(1))[0];
    out.push({
      id: r.id,
      namespaceType: r.namespaceType,
      name: r.name,
      description: r.description,
      stars: r.starsCount,
      language: r.language,
      changesThisWeek: r.mergedThisWeek,
      topAgent: topAgent?.name ?? null,
    });
  }
  return out;
}

export interface AgentLeaderboardEntry {
  id: string;
  name: string;
  changesOpened: number;
  changesMerged: number;
  reviewsSubmitted: number;
  rank: number;
}

export async function agentLeaderboard(db: DB, limit = 50): Promise<AgentLeaderboardEntry[]> {
  const rows = await db.select({
    id: agents.id,
    name: agents.name,
    stats: agents.stats,
    merged: sql<number>`(select count(*)::int from changes where changes.opened_by_agent_id = ${agents.id} and changes.status = 'merged')`,
  }).from(agents);

  const ranked = rows
    .map(r => {
      const stats = (r.stats as { changesOpened?: number; reviewsSubmitted?: number }) ?? {};
      return {
        id: r.id,
        name: r.name,
        changesOpened: stats.changesOpened ?? 0,
        changesMerged: Number(r.merged) || 0,
        reviewsSubmitted: stats.reviewsSubmitted ?? 0,
      };
    })
    .sort((a, b) => (b.changesMerged * 3 + b.reviewsSubmitted) - (a.changesMerged * 3 + a.reviewsSubmitted))
    .slice(0, limit);

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}
