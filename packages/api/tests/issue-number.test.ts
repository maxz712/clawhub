import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, hasTestDb } from "./test-db.js";
import { issues, repositories, users } from "../src/models/schema.js";
import { insertIssueWithNumber, isUniqueViolation, type NewIssue } from "../src/services/issue-number.js";
import { ConflictError } from "../src/services/errors.js";
import type { DB } from "../src/models/db.js";

// #119 — per-repo issue-NUMBER allocation used to be an unguarded
// `SELECT MAX(number)` + `INSERT max+1` at five sites: concurrent creates raced
// into `issues_repo_num_uniq` and surfaced as a raw 500 (API) or a silently
// dropped issue (webhook sync, dep-scan). These cover the shared allocator.

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("duplicate key value violates unique constraint \"issues_repo_num_uniq\""), { code: "23505" });
}

const VALUES: NewIssue = {
  repoId: "11111111-1111-1111-1111-111111111111",
  title: "t",
  createdByKind: "human",
  createdById: "22222222-2222-2222-2222-222222222222",
};

/**
 * Minimal fake DB covering exactly the two shapes the allocator uses: the
 * un-locked hint insert, and the `withChangeUpsertLock` transaction (advisory
 * lock → max → insert). `failures` scripts how many inserts blow up with 23505.
 */
function fakeDb(opts: { currentMax: number | null; failFirstN?: number; failWith?: () => Error }) {
  const state = { inserts: [] as Array<Record<string, unknown>>, txns: 0, hintInserts: 0, attempted: 0 };
  let remainingFailures = opts.failFirstN ?? 0;

  const doInsert = (values: Record<string, unknown>) => {
    state.attempted++;
    if (remainingFailures > 0) { remainingFailures--; throw (opts.failWith ?? uniqueViolation)(); }
    state.inserts.push(values);
    return [{ id: "row", ...values }];
  };
  const insertApi = () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => doInsert(v) }) });
  const selectMax = () => ({ from: () => ({ where: async () => [{ m: opts.currentMax }] }) });

  const tx: unknown = {
    execute: async () => undefined,
    select: selectMax,
    insert: insertApi,
  };
  const db = {
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => { state.hintInserts++; return doInsert(v); } }) }),
    transaction: async (cb: (t: unknown) => Promise<unknown>) => { state.txns++; return cb(tx); },
  };
  return { db: db as unknown as DB, state };
}

describe("isUniqueViolation", () => {
  it("recognises 23505 directly and through a wrapped cause", () => {
    expect(isUniqueViolation(uniqueViolation())).toBe(true);
    expect(isUniqueViolation(Object.assign(new Error("wrapped"), { cause: uniqueViolation() }))).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error("fk"), { code: "23503" }))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("insertIssueWithNumber (allocation)", () => {
  it("allocates MAX(number)+1 under the per-repo advisory lock", async () => {
    const { db, state } = fakeDb({ currentMax: 7 });
    const row = await insertIssueWithNumber(db, VALUES);
    expect(row.number).toBe(8);
    expect(state.txns).toBe(1);      // went through withChangeUpsertLock
    expect(state.hintInserts).toBe(0);
  });

  it("starts at 1 on an empty repo (no behavior change for the sequential case)", async () => {
    const { db } = fakeDb({ currentMax: null });
    expect((await insertIssueWithNumber(db, VALUES)).number).toBe(1);
  });

  it("uses the caller's hint with no extra round-trip (importer fast path)", async () => {
    const { db, state } = fakeDb({ currentMax: 500 });
    const row = await insertIssueWithNumber(db, VALUES, { numberHint: 42 });
    expect(row.number).toBe(42);
    expect(state.hintInserts).toBe(1);
    expect(state.txns).toBe(0);      // no MAX query, no lock — that's the point
  });

  it("falls back to a locked recompute when the hint collides", async () => {
    const { db, state } = fakeDb({ currentMax: 9, failFirstN: 1 });
    const row = await insertIssueWithNumber(db, VALUES, { numberHint: 3 });
    expect(row.number).toBe(10);     // recomputed, not the stale hint
    expect(state.txns).toBe(1);
  });

  it("retries a 23505 from the locked path instead of surfacing a raw 500", async () => {
    // A writer that bypasses the lock can still steal our number mid-flight.
    const { db, state } = fakeDb({ currentMax: 4, failFirstN: 2 });
    const row = await insertIssueWithNumber(db, VALUES);
    expect(row.number).toBe(5);
    expect(state.attempted).toBe(3); // two conflicts, then success
  });

  it("gives up with a typed ConflictError (never spins forever) under permanent conflict", async () => {
    const { db, state } = fakeDb({ currentMax: 1, failFirstN: 1000 });
    await expect(insertIssueWithNumber(db, VALUES)).rejects.toBeInstanceOf(ConflictError);
    expect(state.attempted).toBeLessThanOrEqual(8);
  });

  it("propagates a non-unique-violation error untouched (no retry storm)", async () => {
    const { db, state } = fakeDb({ currentMax: 1, failFirstN: 1, failWith: () => Object.assign(new Error("fk violation"), { code: "23503" }) });
    await expect(insertIssueWithNumber(db, VALUES)).rejects.toThrow("fk violation");
    expect(state.attempted).toBe(1);
  });
});

// The real proof: fire N creates at one repo concurrently against Postgres and
// assert every one landed with a distinct, dense number. Skipped without a DB.
describe.skipIf(!hasTestDb)("insertIssueWithNumber (concurrent, real DB)", () => {
  const db = testDb;
  const S = Date.now();
  let repoId: string, userId: string;

  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `inum-${S}@t.co`, username: `inum${S}`, passwordHash: "x" }).returning();
    userId = u.id;
    const [r] = await db.insert(repositories).values({ name: `inumrepo${S}`, namespaceType: "user", namespaceId: u.id }).returning();
    repoId = r.id;
  });

  it("gives 12 parallel creates 12 distinct consecutive numbers — none lost, none 500", async () => {
    const N = 12;
    const rows = await Promise.all(
      Array.from({ length: N }, (_, i) => insertIssueWithNumber(db, {
        repoId, title: `parallel ${i}`, createdByKind: "human", createdById: userId,
      })),
    );
    const numbers = rows.map(r => r.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(N);
    expect(numbers).toEqual(Array.from({ length: N }, (_, i) => i + 1)); // dense from 1
    const persisted = await db.select().from(issues).where(eq(issues.repoId, repoId));
    expect(persisted).toHaveLength(N);
  });

  it("recovers when an importer hint collides with a number that already exists", async () => {
    // Hint 1 is taken by the previous test — the allocator must not throw.
    const row = await insertIssueWithNumber(db, {
      repoId, title: "stale hint", createdByKind: "human", createdById: userId,
    }, { numberHint: 1 });
    expect(row.number).toBe(13);
  });
});
