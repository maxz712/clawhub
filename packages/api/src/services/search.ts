import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, issues, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { namespaceNameOf } from "./namespace.js";

export interface SearchResult {
  repos: Array<{ id: string; namespace: string; name: string; description: string | null; stars: number; language: string | null }>;
  issues: Array<{ id: string; repoId: string; number: number; title: string; status: string }>;
  changes: Array<{ id: string; repoId: string; branch: string; intent: string; status: string; risk: string }>;
  agents: Array<{ id: string; name: string; changesOpened: number }>;
  code: Array<{ repoId: string; path: string; line: number; excerpt: string }>;
}

export async function search(db: DB, git: GitService | null, q: string, opts: { publicOnly?: boolean; limit?: number } = {}): Promise<SearchResult> {
  const limit = opts.limit ?? 20;
  if (!q.trim()) return { repos: [], issues: [], changes: [], agents: [], code: [] };
  const pattern = `%${q.trim()}%`;

  const repoWhere = opts.publicOnly
    ? and(eq(repositories.isPublic, true), or(ilike(repositories.name, pattern), ilike(repositories.description, pattern))!)
    : or(ilike(repositories.name, pattern), ilike(repositories.description, pattern));

  const repoRows = await db.select().from(repositories).where(repoWhere).orderBy(desc(repositories.starsCount)).limit(limit);

  const nsMap: Record<string, string> = {};
  for (const r of repoRows) {
    const ns = await namespaceNameOf(db, r.namespaceType, r.namespaceId);
    if (ns) nsMap[r.id] = ns;
  }

  const issueRows = await db.select().from(issues).where(
    or(ilike(issues.title, pattern), ilike(issues.body, pattern))
  ).orderBy(desc(issues.updatedAt)).limit(limit);

  const changeRows = await db.select().from(changes).where(
    or(ilike(changes.intent, pattern), ilike(changes.branch, pattern))
  ).orderBy(desc(changes.updatedAt)).limit(limit);

  const agentRows = await db.select().from(agents).where(ilike(agents.name, pattern)).limit(limit);

  // Lightweight code search over public repos using `git grep`. Best-effort only.
  const code: SearchResult["code"] = [];
  if (git) {
    for (const r of repoRows.filter(r => !opts.publicOnly || r.isPublic).slice(0, 5)) {
      const ns = nsMap[r.id];
      if (!ns) continue;
      try {
        const out = await git.open(ns, r.name).raw(["grep", "-n", "-I", "-i", "--fixed-strings", "--heading", q, r.defaultBranch]);
        const lines = out.split("\n").filter(Boolean).slice(0, 10);
        for (const line of lines) {
          const m = line.match(/^(.+?):(\d+):(.*)$/);
          if (m) code.push({ repoId: r.id, path: m[1], line: Number(m[2]), excerpt: m[3].slice(0, 200) });
        }
      } catch { /* no matches or grep unavailable */ }
    }
  }

  return {
    repos: repoRows.map(r => ({
      id: r.id,
      namespace: nsMap[r.id] ?? "",
      name: r.name,
      description: r.description,
      stars: r.starsCount,
      language: r.language,
    })),
    issues: issueRows.map(r => ({ id: r.id, repoId: r.repoId, number: r.number, title: r.title, status: r.status })),
    changes: changeRows.map(r => ({ id: r.id, repoId: r.repoId, branch: r.branch, intent: r.intent, status: r.status, risk: r.risk })),
    agents: agentRows.map(r => ({ id: r.id, name: r.name, changesOpened: ((r.stats as { changesOpened?: number })?.changesOpened) ?? 0 })),
    code,
  };
}

export async function countStats(db: DB): Promise<{ repos: number; agents: number; changes: number; mergedThisWeek: number }> {
  const [{ count: repos }] = await db.select({ count: sql<number>`count(*)::int` }).from(repositories);
  const [{ count: agentCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(agents);
  const [{ count: changesCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(changes);
  const [{ count: mergedThisWeek }] = await db.select({ count: sql<number>`count(*)::int` }).from(changes)
    .where(and(eq(changes.status, "merged"), sql`${changes.updatedAt} > now() - interval '7 days'`));
  return { repos: Number(repos), agents: Number(agentCount), changes: Number(changesCount), mergedThisWeek: Number(mergedThisWeek) };
}
