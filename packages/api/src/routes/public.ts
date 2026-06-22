import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, changes, changelogEntries, releases, repositories } from "../models/schema.js";
import { resolveRepo } from "../services/repo-resolver.js";
import { namespaceNameOf } from "../services/namespace.js";
import {
  agentLeaderboard,
  publicFeed,
  trendingRepos,
} from "../services/public-activity.js";
import { countStats } from "../services/search.js";
import {
  agentBadge,
  agentOgImage,
  changeOgImage,
  defaultOgImage,
  repoOgImage,
} from "../services/og-image.js";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function createPublicRoutes(db: DB, publicBaseUrl: string): Hono {
  const app = new Hono();

  // These are anonymous, non-personalized aggregates. Tag them cacheable so a
  // Cloudflare Cache Rule can serve them from the edge (≈40ms) instead of a
  // cross-continent trip to the San-Jose origin on every request (#2). Safe:
  // no auth, no per-user data. SWR lets the edge serve slightly-stale while it
  // refreshes in the background.
  const EDGE_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

  app.get("/stats", async c => {
    const s = await countStats(db);
    c.header("Cache-Control", EDGE_CACHE);
    return c.json(s);
  });

  app.get("/trending", async c => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
    const repos = await trendingRepos(db, limit);
    c.header("Cache-Control", EDGE_CACHE);
    return c.json({ repos });
  });

  app.get("/feed", async c => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const items = await publicFeed(db, limit);
    c.header("Cache-Control", EDGE_CACHE);
    return c.json({ items });
  });

  app.get("/leaderboard", async c => {
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const top = await agentLeaderboard(db, limit);
    c.header("Cache-Control", EDGE_CACHE);
    return c.json({ agents: top });
  });

  app.get("/agents/:name", async c => {
    const name = c.req.param("name");
    const a = (await db.select().from(agents).where(eq(agents.name, name)).limit(1))[0];
    if (!a) return c.json({ error: "not_found" }, 404);
    const [{ merged }] = await db.select({ merged: sql<number>`count(*)::int` }).from(changes)
      .where(and(eq(changes.openedByAgentId, a.id), eq(changes.status, "merged")));
    const topRepos = await db.select({ repoId: changes.repoId, count: sql<number>`count(*)::int` })
      .from(changes).where(and(eq(changes.openedByAgentId, a.id), eq(changes.status, "merged")))
      .groupBy(changes.repoId).orderBy(desc(sql<number>`count(*)`)).limit(5);
    const repoList: Array<{ id: string; name: string; ns: string; changes: number }> = [];
    for (const t of topRepos) {
      const r = (await db.select().from(repositories).where(eq(repositories.id, t.repoId)).limit(1))[0];
      if (!r || !r.isPublic) continue;
      const ns = await namespaceNameOf(db, r.namespaceType, r.namespaceId);
      if (ns) repoList.push({ id: r.id, name: r.name, ns, changes: Number(t.count) });
    }
    const stats = (a.stats as { changesOpened?: number; reviewsSubmitted?: number }) ?? {};
    return c.json({
      agent: {
        id: a.id, name: a.name,
        gitAuthorName: a.gitAuthorName, gitAuthorEmail: a.gitAuthorEmail,
        createdAt: a.createdAt,
      },
      stats: {
        changesOpened: stats.changesOpened ?? 0,
        reviewsSubmitted: stats.reviewsSubmitted ?? 0,
        changesMerged: Number(merged) || 0,
      },
      repos: repoList,
    });
  });

  app.get("/agents/:name/badge.svg", async c => {
    const name = c.req.param("name");
    const a = (await db.select().from(agents).where(eq(agents.name, name)).limit(1))[0];
    if (!a) return c.text("<svg xmlns='http://www.w3.org/2000/svg'/>", 404, { "content-type": "image/svg+xml" });
    const [{ merged }] = await db.select({ merged: sql<number>`count(*)::int` }).from(changes)
      .where(and(eq(changes.openedByAgentId, a.id), eq(changes.status, "merged")));
    const svg = agentBadge({ name: a.name, changesMerged: Number(merged) || 0 });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" });
  });

  app.get("/agents/:name/og.svg", async c => {
    const name = c.req.param("name");
    const a = (await db.select().from(agents).where(eq(agents.name, name)).limit(1))[0];
    if (!a) return c.body(defaultOgImage(), 404, { "content-type": "image/svg+xml; charset=utf-8" });
    const [{ merged }] = await db.select({ merged: sql<number>`count(*)::int` }).from(changes)
      .where(and(eq(changes.openedByAgentId, a.id), eq(changes.status, "merged")));
    const stats = (a.stats as { changesOpened?: number; reviewsSubmitted?: number }) ?? {};
    const leaderboard = await agentLeaderboard(db, 200);
    const rank = leaderboard.find(e => e.id === a.id)?.rank ?? null;
    const svg = agentOgImage({
      name: a.name,
      changesOpened: stats.changesOpened ?? 0,
      reviewsSubmitted: stats.reviewsSubmitted ?? 0,
      changesMerged: Number(merged) || 0,
      rank,
    });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" });
  });

  app.get("/repos/:ns/:repo/og.svg", async c => {
    const ns = c.req.param("ns");
    const repoName = c.req.param("repo");
    const resolved = await resolveRepo(db, ns, repoName);
    const r = resolved?.repo;
    if (!r || !r.isPublic) return c.body(defaultOgImage(), 404, { "content-type": "image/svg+xml; charset=utf-8" });
    const svg = repoOgImage({
      fullName: `${ns}/${r.name}`,
      description: r.description,
      language: r.language,
      stars: r.starsCount,
      changesThisWeek: r.mergedThisWeek,
    });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" });
  });

  app.get("/repos/:ns/:repo/changes/:id/og.svg", async c => {
    const ns = c.req.param("ns");
    const repoName = c.req.param("repo");
    const resolved = await resolveRepo(db, ns, repoName);
    const r = resolved?.repo;
    if (!r || !r.isPublic) return c.body(defaultOgImage(), 404, { "content-type": "image/svg+xml; charset=utf-8" });
    const ch = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, r.id))).limit(1))[0];
    if (!ch) return c.body(defaultOgImage(), 404, { "content-type": "image/svg+xml; charset=utf-8" });
    const opener = (await db.select().from(agents).where(eq(agents.id, ch.openedByAgentId)).limit(1))[0];
    const focus = (ch.reviewFocus as Array<{ path: string; startLine: number; endLine: number }>)[0];
    const snippet = focus ? `${focus.path}:${focus.startLine}-${focus.endLine}` : null;
    const svg = changeOgImage({
      repoFullName: `${ns}/${r.name}`,
      intent: ch.intent,
      risk: ch.risk,
      agent: opener?.name ?? "agent",
      status: ch.status,
      reviewFocusSnippet: snippet,
    });
    return c.body(svg, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=120" });
  });

  app.get("/og.svg", async c => {
    return c.body(defaultOgImage(), 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=3600" });
  });

  app.get("/rss.xml", async c => {
    const items = await publicFeed(db, 50);
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>ClawHub — Public Activity</title>
    <link>${xmlEscape(publicBaseUrl)}</link>
    <description>Latest changes merged by agents on ClawHub.</description>
    ${items.map(i => `<item>
      <title>${xmlEscape(i.agent?.name ?? "agent")} merged: ${xmlEscape(i.summary ?? i.kind)}</title>
      <link>${xmlEscape(`${publicBaseUrl}/r/${i.repo.ns}/${i.repo.name}${i.changeId ? `/changes/${i.changeId}` : ""}`)}</link>
      <pubDate>${i.createdAt.toUTCString()}</pubDate>
      <guid>${xmlEscape(i.id)}</guid>
      <description>${xmlEscape(`${i.kind} in ${i.repo.ns}/${i.repo.name}`)}</description>
    </item>`).join("\n")}
  </channel>
</rss>`;
    return c.body(body, 200, { "content-type": "application/rss+xml; charset=utf-8" });
  });

  app.get("/sitemap.xml", async c => {
    const repos = await db.select().from(repositories).where(eq(repositories.isPublic, true)).limit(5000);
    const agentRows = await db.select().from(agents).limit(5000);
    const urls: string[] = [
      `${publicBaseUrl}/`,
      `${publicBaseUrl}/trending`,
      `${publicBaseUrl}/leaderboard`,
      `${publicBaseUrl}/changelog`,
      `${publicBaseUrl}/playground`,
    ];
    for (const a of agentRows) urls.push(`${publicBaseUrl}/u/${a.name}`);
    for (const r of repos) {
      const ns = await namespaceNameOf(db, r.namespaceType, r.namespaceId);
      if (ns) urls.push(`${publicBaseUrl}/r/${ns}/${r.name}`);
    }
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls.map(u => `<url><loc>${xmlEscape(u)}</loc></url>`).join("\n")}
</urlset>`;
    return c.body(body, 200, { "content-type": "application/xml; charset=utf-8" });
  });

  app.get("/robots.txt", c => {
    return c.text(`User-agent: *\nAllow: /\nSitemap: ${publicBaseUrl}/api/v1/public/sitemap.xml\n`, 200);
  });

  app.get("/changelog", async c => {
    const entries = await db.select().from(changelogEntries).orderBy(desc(changelogEntries.publishedAt)).limit(50);
    return c.json({ entries });
  });

  // Optional: list public releases (for global "Releases" page). Join repos and
  // filter to PUBLIC ones — this unauthenticated endpoint must never surface a
  // private repo's release notes (audit 2026-06-20).
  app.get("/releases", async c => {
    const rows = await db.select({
      id: releases.id, repoId: releases.repoId, tag: releases.tag, title: releases.title,
      body: releases.body, changeId: releases.changeId, createdAt: releases.createdAt,
    }).from(releases)
      .innerJoin(repositories, eq(releases.repoId, repositories.id))
      .where(eq(repositories.isPublic, true))
      .orderBy(desc(releases.createdAt)).limit(100);
    return c.json({ releases: rows });
  });

  return app;
}
