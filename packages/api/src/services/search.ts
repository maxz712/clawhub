import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, issues, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { namespaceNameOf } from "./namespace.js";

// Max repos to `git grep` per query — bounds search latency. The per-repo
// trigram index (/code/search) is the tool for exhaustive code search.
const CODE_REPO_CAP = 10;

// Parse one `git grep -n <rev>` output line into {path, line, content}. Grepping
// a rev prefixes each hit with `<rev>:`, which we strip. Returns null for lines
// that don't match (e.g. blank). Exported for tests: this parse silently
// returned nothing for years because `--heading` split the filename onto its own
// line — keep it covered.
export function parseGrepLine(raw: string, rev: string): { path: string; line: number; content: string } | null {
  const revPrefix = `${rev}:`;
  const line = raw.startsWith(revPrefix) ? raw.slice(revPrefix.length) : raw;
  const m = line.match(/^(.+?):(\d+):(.*)$/);
  if (!m) return null;
  return { path: m[1], line: Number(m[2]), content: m[3] };
}

export interface SearchResult {
  repos: Array<{ id: string; namespace: string; name: string; description: string | null; stars: number; language: string | null }>;
  issues: Array<{ id: string; repoId: string; number: number; title: string; status: string }>;
  changes: Array<{ id: string; repoId: string; branch: string; intent: string; status: string; risk: string }>;
  agents: Array<{ id: string; name: string; changesOpened: number }>;
  code: Array<{ repoId: string; path: string; line: number; excerpt: string }>;
}

export async function search(
  db: DB,
  git: GitService | null,
  q: string,
  opts: { publicOnly?: boolean; limit?: number; codeRepoIds?: string[] } = {},
): Promise<SearchResult> {
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

  // Lightweight code search via `git grep`. Best-effort only.
  //
  // Grep the repos the CALLER can see (opts.codeRepoIds — typically the caller's
  // visible set), NOT just repos whose name/description matched the text query.
  // Without this, searching for a symbol like `parseConfig` in a repo named
  // `my-app` found nothing — the repo name didn't match the query, so it was
  // never grepped. Fall back to the name-matched repos when no explicit set is
  // given (e.g. an unauthenticated public caller).
  const code: SearchResult["code"] = [];
  if (git) {
    let codeRepos = repoRows;
    if (opts.codeRepoIds?.length) {
      // Bound the fan-out: grep at most CODE_REPO_CAP repos per query. The precise
      // per-repo trigram index (/code/search) is the tool for exhaustive search.
      const ids = opts.codeRepoIds.slice(0, CODE_REPO_CAP);
      codeRepos = await db.select().from(repositories).where(inArray(repositories.id, ids));
      for (const r of codeRepos) {
        if (!nsMap[r.id]) { const ns = await namespaceNameOf(db, r.namespaceType, r.namespaceId); if (ns) nsMap[r.id] = ns; }
      }
    }
    for (const r of codeRepos.filter(r => !opts.publicOnly || r.isPublic).slice(0, CODE_REPO_CAP)) {
      const ns = nsMap[r.id];
      if (!ns) continue;
      try {
        // `-e q` makes q an explicit pattern so a leading-dash query (e.g. "-v")
        // can't be misparsed as a git-grep flag. NOTE: do NOT use `--heading` —
        // it prints the filename on its own line, breaking the `path:line:content`
        // parse below (which silently returned ZERO code results for every repo).
        // Grepping a rev prefixes each hit with `<rev>:`, which we strip.
        const out = await git.open(ns, r.name).raw(["grep", "-n", "-I", "-i", "--fixed-strings", "-e", q, r.defaultBranch]);
        const lines = out.split("\n").filter(Boolean).slice(0, 10);
        for (const raw of lines) {
          const hit = parseGrepLine(raw, r.defaultBranch);
          if (hit) code.push({ repoId: r.id, path: hit.path, line: hit.line, excerpt: hit.content.slice(0, 200) });
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
