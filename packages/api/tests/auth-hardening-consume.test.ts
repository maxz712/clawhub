import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { consumeEmailVerification, consumePasswordReset, issueEmailVerification, issuePasswordReset } from "../src/services/auth-hardening.js";
import { verifyPassword } from "../src/services/auth.js";
import { emailVerifications, passwordResets, users } from "../src/models/schema.js";
import { hasTestDb, testDb } from "./test-db.js";
import type { DB } from "../src/models/db.js";

// Issue #105 — the siblings of the #99 TOTP fix. consumePasswordReset and
// consumeEmailVerification were non-atomic read-check-write: SELECT the row,
// check usedAt/verifiedAt on the in-memory snapshot, then UPDATE unconditionally
// by id — so two concurrent redemptions of the same single-use token both
// succeeded. The fix (same invariant totp-replay.test.ts documents) claims the
// token with ONE conditional UPDATE guarded on the CURRENT row state and trusts
// the affected-row count, never the snapshot. The claim also lands BEFORE the
// expensive hashPassword, closing the widest part of the window entirely.

// ---------------------------------------------------------------------------
// Stateful fake DB modelling the conditional UPDATE's row-level atomicity for
// one token row per table (totp-replay.test.ts style): the WHERE guard
// evaluates against the CURRENT stored value (as Postgres would), and
// .returning() reports whether a row was claimed. Bogus-token lookups are the
// Postgres suite's job — the fake models one existing row and its consumed /
// expired state, which is where the race lives.
// ---------------------------------------------------------------------------
function fakeDb(opts: { expired?: boolean } = {}) {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);
  const state = {
    reset: { userId: "u1", usedAt: null as Date | null, expiresAt: opts.expired ? past : future },
    verification: { userId: "u1", verifiedAt: null as Date | null, expiresAt: opts.expired ? past : future },
    userWrites: [] as Array<Record<string, unknown>>,
  };
  const db = {
    state,
    update(table: unknown) {
      return {
        set(v: Record<string, unknown>) {
          const where = () => {
            const result = {
              returning() {
                if (table === passwordResets) {
                  const row = state.reset;
                  if (row.usedAt !== null || row.expiresAt <= new Date()) return Promise.resolve([]);
                  row.usedAt = v.usedAt as Date;
                  return Promise.resolve([{ userId: row.userId }]);
                }
                if (table === emailVerifications) {
                  const row = state.verification;
                  if (row.verifiedAt !== null || row.expiresAt <= new Date()) return Promise.resolve([]);
                  row.verifiedAt = v.verifiedAt as Date;
                  return Promise.resolve([{ userId: row.userId }]);
                }
                return Promise.resolve([]);
              },
              // The users password write is awaited without .returning().
              then(resolve: (v: unknown) => void) {
                if (table === users) state.userWrites.push(v);
                resolve(undefined);
              },
            };
            return result;
          };
          return { where };
        },
      };
    },
  };
  return db as unknown as DB & { state: typeof state };
}

describe("consumePasswordReset (single-use claim, fake row-atomicity)", () => {
  it("consumes once, then rejects the spent token without touching the password again", async () => {
    const db = fakeDb();
    expect(await consumePasswordReset(db, "tok", "new-password-1")).toBe(true);
    expect(db.state.userWrites.length).toBe(1);
    expect(await consumePasswordReset(db, "tok", "attacker-password")).toBe(false);
    expect(db.state.userWrites.length).toBe(1);
  });

  it("lets exactly ONE of two concurrent redemptions win — one password mutation total", async () => {
    const db = fakeDb();
    const [a, b] = await Promise.all([
      consumePasswordReset(db, "tok", "password-from-a"),
      consumePasswordReset(db, "tok", "password-from-b"),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(db.state.userWrites.length).toBe(1);
  });

  it("rejects an expired token without any write", async () => {
    const db = fakeDb({ expired: true });
    expect(await consumePasswordReset(db, "tok", "new-password-1")).toBe(false);
    expect(db.state.userWrites.length).toBe(0);
    expect(db.state.reset.usedAt).toBeNull();
  });
});

describe("consumeEmailVerification (single-use claim, fake row-atomicity)", () => {
  it("verifies once, then rejects the spent token", async () => {
    const db = fakeDb();
    expect(await consumeEmailVerification(db, "tok")).toBe("u1");
    expect(await consumeEmailVerification(db, "tok")).toBeNull();
  });

  it("lets exactly ONE of two concurrent consumes win", async () => {
    const db = fakeDb();
    const [a, b] = await Promise.all([
      consumeEmailVerification(db, "tok"),
      consumeEmailVerification(db, "tok"),
    ]);
    expect([a, b].filter(v => v !== null).length).toBe(1);
  });

  it("rejects an expired token", async () => {
    const db = fakeDb({ expired: true });
    expect(await consumeEmailVerification(db, "tok")).toBeNull();
    expect(db.state.verification.verifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Real-Postgres integration: exercises the actual conditional UPDATE SQL under
// genuine concurrency. Runs only when CLAWHUB_TEST_DATABASE_URL is set.
// ---------------------------------------------------------------------------
describe.skipIf(!hasTestDb)("password reset + email verification consumes (Postgres, concurrent race)", () => {
  async function freshUser() {
    const S = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const [row] = await testDb.insert(users)
      .values({ email: `consume-race-${S}@test.local`, username: `consumerace${S.replace(/[^a-z0-9]/g, "")}`, passwordHash: "x" })
      .returning();
    return row;
  }

  it("N racers on one reset token → exactly one success, one password write, spent thereafter", async () => {
    const user = await freshUser();
    try {
      const { token } = await issuePasswordReset(testDb, user.email);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => consumePasswordReset(testDb, token!, `racer-password-${i}`)),
      );
      expect(results.filter(Boolean).length).toBe(1);

      // Exactly one mutation landed: the winner's password verifies, the
      // token_version bumped exactly once, and the token row is spent.
      const winner = results.findIndex(Boolean);
      const [after] = await testDb.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(await verifyPassword(`racer-password-${winner}`, after.passwordHash!)).toBe(true);
      expect(after.tokenVersion).toBe(user.tokenVersion + 1);
      const [resetRow] = await testDb.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).limit(1);
      expect(resetRow.usedAt).not.toBeNull();

      // A fresh sequential replay of the spent token also fails closed.
      expect(await consumePasswordReset(testDb, token!, "late-replay-password")).toBe(false);
    } finally {
      await testDb.delete(users).where(eq(users.id, user.id));
    }
  });

  it("an expired reset token fails closed and stays unclaimed", async () => {
    const user = await freshUser();
    try {
      const { token } = await issuePasswordReset(testDb, user.email);
      await testDb.update(passwordResets)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(passwordResets.userId, user.id));
      expect(await consumePasswordReset(testDb, token!, "too-late-password")).toBe(false);
      const [resetRow] = await testDb.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).limit(1);
      expect(resetRow.usedAt).toBeNull();
      const [after] = await testDb.select().from(users).where(eq(users.id, user.id)).limit(1);
      expect(after.passwordHash).toBe("x");
    } finally {
      await testDb.delete(users).where(eq(users.id, user.id));
    }
  });

  it("N racers on one verification token → exactly one gets the userId", async () => {
    const user = await freshUser();
    try {
      const token = await issueEmailVerification(testDb, user.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => consumeEmailVerification(testDb, token)),
      );
      expect(results.filter(v => v !== null)).toEqual([user.id]);
      const [row] = await testDb.select().from(emailVerifications).where(eq(emailVerifications.userId, user.id)).limit(1);
      expect(row.verifiedAt).not.toBeNull();
      expect(await consumeEmailVerification(testDb, token)).toBeNull();
    } finally {
      await testDb.delete(users).where(eq(users.id, user.id));
    }
  });
});
