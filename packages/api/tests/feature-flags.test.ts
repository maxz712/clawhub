import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { featureFlags, repositories, users } from "../src/models/schema.js";
import { upsertFlag, evaluate } from "../src/services/feature-flags.js";

// Rollout bucketing uses sha256(key:ident) & mod 100.
function bucketFor(key: string, ident: string): number {
  const h = createHash("sha256").update(`${key}:${ident}`).digest();
  return h.readUInt32BE(0) % 100;
}

describe("feature-flag bucketing", () => {
  it("is deterministic per (key, ident)", () => {
    const a = bucketFor("new-ui", "user-1");
    const b = bucketFor("new-ui", "user-1");
    expect(a).toBe(b);
  });

  it("distributes reasonably across idents", () => {
    const counts: Record<number, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const bucket = bucketFor("x", `id-${i}`);
      counts[Math.floor(bucket / 10)] = (counts[Math.floor(bucket / 10)] ?? 0) + 1;
    }
    // Expect each of the 10 deciles to land within ±20% of 1000.
    for (let i = 0; i < 10; i++) {
      expect(counts[i]).toBeGreaterThan(800);
      expect(counts[i]).toBeLessThan(1200);
    }
  });
});

// Regression for #89: repo-scoped and global (repoId IS NULL) flags share the
// `(repoId, key)` unique index, so a repo-scoped flag and a global flag may use
// the SAME key. The global lookup branch of upsertFlag/evaluate must filter on
// `repoId IS NULL`, never a bare key match — otherwise a repo's flag leaks/gets
// overwritten cross-tenant. Needs a real migrated Postgres (CLAWHUB_TEST_DATABASE_URL).
describe.skipIf(!hasTestDb)("listFlags global scoping (#95)", () => {
  const S2 = Date.now() + 7;
  let scopedRepoId: string;
  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `lf-${S2}@t.co`, username: `lfu${S2}`, passwordHash: "x" }).returning();
    const [r] = await db.insert(repositories).values({ name: `lfrepo${S2}`, namespaceType: "user", namespaceId: u.id }).returning();
    scopedRepoId = r.id;
    await db.insert(featureFlags).values({ repoId: null, key: `lf-global-${S2}`, enabled: true });
    await db.insert(featureFlags).values({ repoId: scopedRepoId, key: `lf-scoped-${S2}`, enabled: true });
  });

  it("the global branch returns ONLY repoId IS NULL rows — never other repos' rules", async () => {
    const { listFlags } = await import("../src/services/feature-flags.js");
    const globals = await listFlags(db);
    expect(globals.some(f => f.key === `lf-global-${S2}`)).toBe(true);
    expect(globals.every(f => f.repoId === null)).toBe(true);           // the #95 leak
    expect(globals.some(f => f.key === `lf-scoped-${S2}`)).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("feature-flag scope isolation (#89)", () => {
  const S = Date.now();
  const KEY = `shared-key-${S}`;
  let repoId: string;

  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `ff-${S}@t.co`, username: `ffu${S}`, passwordHash: "x" }).returning();
    const [r] = await db.insert(repositories).values({ name: `ffrepo${S}`, namespaceType: "user", namespaceId: u.id }).returning();
    repoId = r.id;

    // Same key, two scopes, deliberately different config so we can tell which row resolved.
    await upsertFlag(db, { repoId, key: KEY, enabled: true, rolloutPercent: 100, rules: [{ match: { userId: "secret-allowlisted-user" }, enabled: true }] });
    await upsertFlag(db, { repoId: null, key: KEY, enabled: false, rolloutPercent: 0 });
  });

  it("upsert keeps the repo-scoped and global rows as two distinct rows", async () => {
    const rows = await db.select().from(featureFlags).where(eq(featureFlags.key, KEY));
    expect(rows.length).toBe(2);
    const repoRow = rows.find((r) => r.repoId === repoId);
    const globalRow = rows.find((r) => r.repoId === null);
    expect(repoRow).toBeTruthy();
    expect(globalRow).toBeTruthy();
    // The global upsert must NOT have overwritten the repo-scoped row's config.
    expect(repoRow!.enabled).toBe(true);
    expect(repoRow!.rolloutPercent).toBe(100);
    expect(globalRow!.enabled).toBe(false);
    expect(globalRow!.rolloutPercent).toBe(0);
  });

  it("a global upsert on a shared key never matches/overwrites the repo-scoped row", async () => {
    await upsertFlag(db, { repoId: null, key: KEY, enabled: true, rolloutPercent: 55 });
    const globalRow = (await db.select().from(featureFlags)
      .where(and(isNull(featureFlags.repoId), eq(featureFlags.key, KEY))).limit(1))[0];
    const repoRow = (await db.select().from(featureFlags)
      .where(and(eq(featureFlags.repoId, repoId), eq(featureFlags.key, KEY))).limit(1))[0];
    expect(globalRow.rolloutPercent).toBe(55); // global updated in place
    expect(repoRow.rolloutPercent).toBe(100);  // repo row untouched
    expect(repoRow.enabled).toBe(true);
  });

  it("evaluate({repoId: null}) resolves ONLY the global row, never the repo-scoped one", async () => {
    // The repo row is enabled with a targeting rule for `secret-allowlisted-user`.
    // A global evaluate for that same context must NOT leak the repo rule.
    const res = await evaluate(db, { key: KEY, repoId: null, context: { userId: "secret-allowlisted-user" } });
    // Global row (after the prior test) is enabled=true, rollout=55 — resolves by
    // bucketing, and crucially reports NO `rule_match` from the repo's private rule.
    expect(res.reason).not.toBe("rule_match");
  });

  it("evaluate({repoId}) resolves the repo-scoped row, and a bogus key is flag_missing", async () => {
    const hit = await evaluate(db, { key: KEY, repoId, context: { userId: "secret-allowlisted-user" } });
    expect(hit).toEqual({ enabled: true, reason: "rule_match" });
    const miss = await evaluate(db, { key: `nope-${S}`, repoId: null, context: {} });
    expect(miss).toEqual({ enabled: false, reason: "flag_missing" });
  });
});
