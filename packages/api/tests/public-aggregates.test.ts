import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { agents, changes, repositories, reviews, users } from "../src/models/schema.js";
import { createPublicRoutes } from "../src/routes/public.js";
import { agentLeaderboard } from "../src/services/public-activity.js";
import { publicAgentStats } from "../src/services/public-stats.js";
import { countStats } from "../src/services/search.js";
import { hasTestDb, testDb } from "./test-db.js";

// #122 — THE RULE: every public surface filters on repo visibility, AGGREGATES
// INCLUDED. Row-returning endpoints always did; the counts beside them did not,
// so `/public/agents/:name` published `changesMerged` from private repos in the
// same response whose `repos` list it had just redacted to `[]`.
//
// The bug is copy-paste drift across five call sites, so this file asserts the
// rule at EVERY site rather than at the helper. Assertions are written to be
// isolation-safe (this DB is shared with other suites): per-agent numbers are
// exact, instance-wide numbers are pinned to an independently-computed
// public-only query rather than to a literal.

describe.skipIf(!hasTestDb)("public aggregates never count private repos (#122)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  /**
   * One agent with EXACTLY one merged Change + one review in a PUBLIC repo and
   * the same in a PRIVATE repo. Every public surface must report the public
   * half only — 1, never 2. Plus a second agent whose only work is private: it
   * must not appear on the leaderboard or in the sitemap at all.
   */
  async function seed() {
    const handle = `pub-${uniq()}`;
    const [user] = await testDb.insert(users).values({ email: `${handle}@t.local`, username: handle, passwordHash: "x" }).returning();

    const mk = async (isPublic: boolean) => (await testDb.insert(repositories).values({
      name: `r-${uniq()}`, namespaceType: "user", namespaceId: user.id, defaultBranch: "main", isPublic,
    }).returning())[0];
    const publicRepo = await mk(true);
    const privateRepo = await mk(false);

    const mkAgent = async (prefix: string) => (await testDb.insert(agents).values({
      name: `${prefix}-${uniq()}`, tokenHash: "x", gitAuthorName: "b", gitAuthorEmail: "b@a.local",
      associatedUserId: user.id, createdByUserId: user.id,
      // Deliberately POLLUTED denormalized counters — they are the lifetime
      // private+public total (bumped unconditionally by post-push/reviews), and
      // no public surface may echo them.
      stats: { changesOpened: 999, reviewsSubmitted: 999 },
    }).returning())[0];
    const agent = await mkAgent("bot");
    const privateOnly = await mkAgent("ghost");

    const mkChange = async (repoId: string, agentId: string) => (await testDb.insert(changes).values({
      repoId, branch: `b-${uniq()}`, headCommit: "a".repeat(40), intent: "seed", status: "merged",
      openedByAgentId: agentId,
    }).returning())[0];
    const publicChange = await mkChange(publicRepo.id, agent.id);
    const privateChange = await mkChange(privateRepo.id, agent.id);
    await mkChange(privateRepo.id, privateOnly.id);

    for (const ch of [publicChange, privateChange]) {
      await testDb.insert(reviews).values({
        changeId: ch.id, reviewerKind: "agent", reviewerId: agent.id, verdict: "comment", basis: "code",
      });
    }

    return { user, agent, privateOnly, publicRepo, privateRepo };
  }

  const routes = () => createPublicRoutes(testDb, "https://clawhub.test");

  it("publicAgentStats counts only public-repo work", async () => {
    const { agent, privateOnly } = await seed();
    expect(await publicAgentStats(testDb, agent.id)).toEqual({
      changesOpened: 1, changesMerged: 1, reviewsSubmitted: 1,
    });
    // An agent whose every Change is private reads as all-zero — consistent with
    // the empty `repos` list the same profile already returned.
    expect(await publicAgentStats(testDb, privateOnly.id)).toEqual({
      changesOpened: 0, changesMerged: 0, reviewsSubmitted: 0,
    });
  });

  it("GET /agents/:name reports the public half and never the polluted stats blob", async () => {
    const { agent, privateRepo, publicRepo } = await seed();
    const res = await routes().request(`/agents/${agent.name}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { stats: Record<string, number>; repos: Array<{ name: string }> };
    expect(body.stats).toEqual({ changesOpened: 1, changesMerged: 1, reviewsSubmitted: 1 });
    // The 999s from `agents.stats` must not survive anywhere in the response.
    expect(JSON.stringify(body)).not.toContain("999");
    expect(body.repos.map(r => r.name)).toEqual([publicRepo.name]);
    expect(JSON.stringify(body)).not.toContain(privateRepo.name);
  });

  it("badge.svg and og.svg render the same filtered count", async () => {
    const { agent, privateRepo } = await seed();
    const app = routes();
    const badge = await (await app.request(`/agents/${agent.name}/badge.svg`)).text();
    // The badge renders "<n> merged" — the private Change must not be in it.
    expect(badge).toContain("1 merged");
    expect(badge).not.toContain("2 merged");

    const og = await (await app.request(`/agents/${agent.name}/og.svg`)).text();
    expect(og).not.toContain("999");
    expect(og).not.toContain(privateRepo.name);
    // og renders opened/merged/reviews; every one of them is the public 1.
    expect(og.match(/>2</g)).toBeNull();
  });

  it("the leaderboard ranks on public-only counts and agrees with the profile", async () => {
    const { agent, privateOnly } = await seed();
    const board = await agentLeaderboard(testDb, 500);
    const entry = board.find(e => e.id === agent.id);
    expect(entry).toBeDefined();
    expect(entry!.changesMerged).toBe(1);
    expect(entry!.changesOpened).toBe(1);
    expect(entry!.reviewsSubmitted).toBe(1);

    // The profile and the board are supposed to be the same numbers; they used
    // to disagree (profile counted all repos, board read the stats blob).
    const profile = await (await routes().request(`/agents/${agent.name}`)).json() as { stats: Record<string, number> };
    expect(profile.stats).toEqual({
      changesOpened: entry!.changesOpened,
      changesMerged: entry!.changesMerged,
      reviewsSubmitted: entry!.reviewsSubmitted,
    });

    // An entirely-private agent is off the board entirely.
    expect(board.find(e => e.id === privateOnly.id)).toBeUndefined();
  });

  it("the leaderboard omits archived agents even when their public work counts", async () => {
    const { publicRepo } = await seed();
    const [archived] = await testDb.insert(agents).values({
      name: `arch-${uniq()}`, tokenHash: "x", gitAuthorName: "b", gitAuthorEmail: "b@a.local",
      archivedAt: new Date(),
    }).returning();
    await testDb.insert(changes).values({
      repoId: publicRepo.id, branch: `b-${uniq()}`, headCommit: "a".repeat(40), intent: "seed",
      status: "merged", openedByAgentId: archived.id,
    });
    // The work IS public — it is the agent that is soft-deleted, and an archived
    // agent is hidden from every listing (the routes/agents.ts exclusion).
    expect((await publicAgentStats(testDb, archived.id)).changesMerged).toBe(1);
    expect((await agentLeaderboard(testDb, 500)).find(e => e.id === archived.id)).toBeUndefined();
  });

  it("countStats reports public repos and public Changes only", async () => {
    await seed();
    const s = await countStats(testDb);
    const [{ n: publicRepos }] = await testDb.select({ n: sql<number>`count(*)::int` })
      .from(repositories).where(eq(repositories.isPublic, true));
    const [{ n: publicChanges }] = await testDb.select({ n: sql<number>`count(*)::int` })
      .from(changes).innerJoin(repositories, eq(changes.repoId, repositories.id))
      .where(eq(repositories.isPublic, true));
    const [{ n: allRepos }] = await testDb.select({ n: sql<number>`count(*)::int` }).from(repositories);

    expect(s.repos).toBe(Number(publicRepos));
    expect(s.changes).toBe(Number(publicChanges));
    // The seed guarantees at least one private repo exists, so "filtered" and
    // "unfiltered" are genuinely different numbers here — this assertion fails
    // on the pre-fix code rather than passing vacuously.
    expect(Number(allRepos)).toBeGreaterThan(Number(publicRepos));
  });

  it("sitemap.xml lists agents with public activity and omits private-only and archived ones", async () => {
    const { agent, privateOnly, publicRepo, privateRepo } = await seed();
    const [archived] = await testDb.insert(agents).values({
      name: `arch-${uniq()}`, tokenHash: "x", gitAuthorName: "b", gitAuthorEmail: "b@a.local",
      archivedAt: new Date(),
    }).returning();
    await testDb.insert(changes).values({
      repoId: publicRepo.id, branch: `b-${uniq()}`, headCommit: "a".repeat(40), intent: "seed",
      status: "merged", openedByAgentId: archived.id,
    });

    const xml = await (await routes().request("/sitemap.xml")).text();
    expect(xml).toContain(`/u/${agent.name}`);
    expect(xml).not.toContain(`/u/${privateOnly.name}`);
    expect(xml).not.toContain(`/u/${archived.name}`);
    expect(xml).toContain(`/${publicRepo.name}`);
    expect(xml).not.toContain(privateRepo.name);
  });

  it("a review on a private Change never counts, even for an agent with public work", async () => {
    const { agent, privateRepo } = await seed();
    // Pile on private reviews: the public figure must not move.
    const [extra] = await testDb.insert(changes).values({
      repoId: privateRepo.id, branch: `b-${uniq()}`, headCommit: "a".repeat(40), intent: "seed", status: "merged",
    }).returning();
    for (let i = 0; i < 5; i++) {
      await testDb.insert(reviews).values({
        changeId: extra.id, reviewerKind: "agent", reviewerId: agent.id, verdict: "comment", basis: "code",
      });
    }
    expect((await publicAgentStats(testDb, agent.id)).reviewsSubmitted).toBe(1);
  });

  it("flipping a repo to public immediately makes its work countable", async () => {
    const { agent, privateRepo } = await seed();
    await testDb.update(repositories).set({ isPublic: true }).where(eq(repositories.id, privateRepo.id));
    // Read-time filtering means visibility changes take effect with no backfill.
    expect(await publicAgentStats(testDb, agent.id)).toEqual({
      changesOpened: 2, changesMerged: 2, reviewsSubmitted: 2,
    });
    const [{ n }] = await testDb.select({ n: sql<number>`count(*)::int` }).from(changes)
      .where(and(eq(changes.repoId, privateRepo.id), eq(changes.status, "merged")));
    expect(Number(n)).toBeGreaterThan(0);
  });
});
