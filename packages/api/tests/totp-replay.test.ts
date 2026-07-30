import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { generateSecret, totpCode, verifyTotpStep, sealTotpSecret, openTotpSecret, verifyAndConsumeTotp } from "../src/services/totp.js";
import { users } from "../src/models/schema.js";
import { hasTestDb, testDb } from "./test-db.js";

// Audit follow-up: TOTP codes must be single-use within their window (replay
// guard) and the secret roundtrips through seal/open. Issue #99: the consume
// must be ATOMIC — two logins racing on the same code may not both succeed, so
// verifyAndConsumeTotp claims the step with a conditional UPDATE and trusts the
// affected-row count, never the (possibly stale) row it was handed.

// Stateful fake DB modelling the row + the conditional UPDATE's row-level
// atomicity: the guard evaluates against the CURRENT stored value (as Postgres
// would), not the snapshot the caller read, and .returning() reports whether a
// row was claimed. Writes are recorded for assertions.
function fakeDb(initialLastStep: number | null = null) {
  const state = { totpLastStep: initialLastStep };
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    state,
    writes,
    update() {
      return {
        set(v: Record<string, unknown>) {
          return {
            where() {
              return {
                returning() {
                  const step = v.totpLastStep as number;
                  const current = state.totpLastStep;
                  if (current != null && current >= step) return Promise.resolve([]);
                  state.totpLastStep = step;
                  writes.push(v);
                  return Promise.resolve([{ id: "u1" }]);
                },
              };
            },
          };
        },
      };
    },
  };
  return db as unknown as Parameters<typeof verifyAndConsumeTotp>[0] & { state: typeof state; writes: typeof writes };
}

describe("TOTP seal/open roundtrip", () => {
  it("opens what it sealed (sealed or plaintext-fallback)", () => {
    const secret = generateSecret();
    const { secret: stored, nonce } = sealTotpSecret(secret);
    expect(openTotpSecret(stored, nonce)).toBe(secret);
  });
});

describe("verifyTotpStep", () => {
  it("returns a monotonic step for a valid code and null for a wrong one", () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const step = verifyTotpStep(secret, totpCode(secret, at), at);
    expect(step).not.toBeNull();
    expect(verifyTotpStep(secret, "000000", at)).toBeNull();
    // A code one window later resolves to a strictly greater step.
    const later = verifyTotpStep(secret, totpCode(secret, at + 30_000), at + 30_000);
    expect(later!).toBeGreaterThan(step!);
  });
});

describe("verifyAndConsumeTotp (single-use replay guard)", () => {
  it("accepts a code once, then rejects the same code as a replay", async () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, at);
    const db = fakeDb();
    const user = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null as number | null };

    // First use: accepted, and a last-step is persisted.
    expect(await verifyAndConsumeTotp(db, user, code, at)).toBe(true);
    expect(db.writes.length).toBe(1);
    const consumedStep = db.writes[0].totpLastStep as number;

    // Simulate persistence, then replay the SAME code → rejected.
    user.totpLastStep = consumedStep;
    expect(await verifyAndConsumeTotp(db, user, code, at)).toBe(false);
  });

  it("rejects an invalid code without consuming", async () => {
    const secret = generateSecret();
    const db = fakeDb();
    const user = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
    expect(await verifyAndConsumeTotp(db, user, "000000", 1_700_000_000_000)).toBe(false);
    expect(db.writes.length).toBe(0);
  });

  it("rejects a replay even when handed a STALE row (correctness comes from the guarded UPDATE)", async () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, at);
    const step = verifyTotpStep(secret, code, at)!;
    // The DB already recorded the step (another request consumed it), but the
    // caller's row snapshot predates that — as at POST /login, where the row is
    // SELECTed well before verifyAndConsumeTotp runs.
    const db = fakeDb(step);
    const staleUser = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
    expect(await verifyAndConsumeTotp(db, staleUser, code, at)).toBe(false);
    expect(db.writes.length).toBe(0);
  });

  it("lets exactly ONE of two concurrent consumers of the same code win", async () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, at);
    const db = fakeDb();
    // Both requests read the row before either wrote — same stale snapshot.
    const snapshotA = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
    const snapshotB = { id: "u1", totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
    const [a, b] = await Promise.all([
      verifyAndConsumeTotp(db, snapshotA, code, at),
      verifyAndConsumeTotp(db, snapshotB, code, at),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(db.writes.length).toBe(1);
  });
});

// Real-Postgres integration: exercises the actual conditional UPDATE SQL, not
// the fake's simulation. Runs only when CLAWHUB_TEST_DATABASE_URL is set.
describe.skipIf(!hasTestDb)("verifyAndConsumeTotp (Postgres, concurrent race)", () => {
  it("N racers sharing one stale row snapshot yield exactly one success", async () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, at);
    const email = `totp-race-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
    const [row] = await testDb.insert(users)
      .values({ email, passwordHash: "x", totpSecret: secret, totpEnabled: true })
      .returning();
    try {
      // Every request SELECTed the row before any UPDATE landed — all see
      // totpLastStep = null, mirroring simultaneous POST /login handlers.
      const stale = { id: row.id, totpSecret: secret, totpSecretNonce: null, totpLastStep: null };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => verifyAndConsumeTotp(testDb, { ...stale }, code, at)),
      );
      expect(results.filter(Boolean).length).toBe(1);

      // The consumed step is persisted; a fresh sequential replay also fails.
      const [after] = await testDb.select().from(users).where(eq(users.id, row.id)).limit(1);
      expect(Number(after.totpLastStep)).toBe(verifyTotpStep(secret, code, at));
      expect(await verifyAndConsumeTotp(testDb, after, code, at)).toBe(false);

      // A LATER window's code still works (guard is strictly-less-than, not equality).
      const laterCode = totpCode(secret, at + 30_000);
      expect(await verifyAndConsumeTotp(testDb, after, laterCode, at + 30_000)).toBe(true);
    } finally {
      await testDb.delete(users).where(eq(users.id, row.id));
    }
  });
});
