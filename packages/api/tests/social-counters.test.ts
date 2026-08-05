import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { and, count, eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { repositories, repoStars, repoWatchers, users } from "../src/models/schema.js";
import { signToken } from "../src/services/auth.js";
import { createSocialRoutes } from "../src/routes/social.js";
import { errorHandler } from "../src/middleware/errorHandler.js";

// Star/watch counter integrity (#114). `repo_stars_uniq` / `repo_watchers_uniq` make a
// repeated POST a row-level no-op, so the denormalized counter MUST be gated on the insert
// actually happening. It used to increment unconditionally, which let any authenticated
// caller inflate `starsCount` — the ranking key for trending + search — by replaying POST.
// The invariant asserted here: counter == COUNT(*) of the rows, after ANY call sequence.
const S = Date.now();
let app: Hono, token: string, ns: string, repoName: string, repoId: string;

describe.skipIf(!hasTestDb)("social counters stay in step with the rows", () => {
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `sc-${S}@t.co`, username: `scu${S}`, passwordHash: "x" }).returning();
    ns = u.username!;
    token = signToken({ kind: "user", userId: u.id, email: u.email });
    repoName = `screpo${S}`;
    const [r] = await db.insert(repositories).values({ name: repoName, namespaceType: "user", namespaceId: u.id }).returning();
    repoId = r.id;
    app = new Hono();
    app.route("/api/v1", createSocialRoutes(db));
    app.onError(errorHandler);
  });

  const call = (kind: "star" | "watch", method: "POST" | "DELETE") => app.request(
    `/api/v1/repos/${ns}/${repoName}/${kind}`,
    { method, headers: { authorization: `Bearer ${token}` } },
  );
  const social = async () => {
    const res = await app.request(`/api/v1/repos/${ns}/${repoName}/social`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ starred: boolean; watching: boolean; stars: number; watchers: number }>;
  };
  const rowCounts = async () => ({
    stars: (await db.select({ n: count() }).from(repoStars).where(eq(repoStars.repoId, repoId)))[0].n,
    watchers: (await db.select({ n: count() }).from(repoWatchers).where(eq(repoWatchers.repoId, repoId)))[0].n,
  });

  it("the first star increments to 1", async () => {
    expect((await call("star", "POST")).status).toBe(200);
    const s = await social();
    expect(s.starred).toBe(true);
    expect(s.stars).toBe(1);
    expect((await rowCounts()).stars).toBe(1);
  });

  it("N duplicate stars by the same user leave starsCount at 1", async () => {
    for (let i = 0; i < 5; i++) expect((await call("star", "POST")).status).toBe(200);
    const s = await social();
    expect(s.stars).toBe(1);          // was 6 before the fix — one phantom star per retry
    expect((await rowCounts()).stars).toBe(1);
    expect(s.stars).toBe((await rowCounts()).stars);
  });

  it("unstar decrements to 0 and repeat unstars never go below it", async () => {
    expect((await call("star", "DELETE")).status).toBe(200);
    expect((await social()).stars).toBe(0);
    for (let i = 0; i < 3; i++) expect((await call("star", "DELETE")).status).toBe(200);
    const s = await social();
    expect(s.starred).toBe(false);
    expect(s.stars).toBe(0);
    expect((await rowCounts()).stars).toBe(0);
  });

  it("counter == row count after an interleaved star/unstar sequence", async () => {
    for (const m of ["POST", "POST", "DELETE", "POST", "POST", "POST"] as const) await call("star", m);
    const s = await social();
    expect((await rowCounts()).stars).toBe(1);
    expect(s.stars).toBe(1);
    expect(s.starred).toBe(true);
  });

  it("N duplicate watches leave watchersCount at 1, and unwatch returns it to 0", async () => {
    for (let i = 0; i < 4; i++) expect((await call("watch", "POST")).status).toBe(200);
    let s = await social();
    expect(s.watching).toBe(true);
    expect(s.watchers).toBe(1);       // was 4 before the fix
    expect((await rowCounts()).watchers).toBe(1);

    expect((await call("watch", "DELETE")).status).toBe(200);
    expect((await call("watch", "DELETE")).status).toBe(200);
    s = await social();
    expect(s.watching).toBe(false);
    expect(s.watchers).toBe(0);
    expect((await rowCounts()).watchers).toBe(0);
  });
});
