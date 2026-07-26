import { describe, it, expect, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { testDb as db, hasTestDb } from "./test-db.js";
import { agents, agentUsage, users } from "../src/models/schema.js";
import { bumpUsage, currentUsage, enforceRate, upsertQuota } from "../src/services/agent-scope.js";
import { ForbiddenError } from "../src/services/errors.js";

// Regression for #92: bumpUsage used to be a read-then-write (SELECT count → +1
// in JS → UPDATE) with no atomic increment and no lock, so concurrent requests
// lost updates — the persisted count fell far below the true request count and
// enforceRate never tripped, letting an agent blow past its per-hour push/review/
// api quota. The fix makes bumpUsage a single atomic INSERT ... ON CONFLICT DO
// UPDATE SET count = count + 1 RETURNING count against `agent_usage_uniq`.
// Needs a real migrated Postgres (CLAWHUB_TEST_DATABASE_URL).
describe.skipIf(!hasTestDb)("agent rate-limit atomicity (#92)", () => {
  const S = Date.now();
  let agentId: string;

  beforeAll(async () => {
    const [u] = await db.insert(users).values({ email: `rate-${S}@t.co`, username: `rateu${S}`, passwordHash: "x" }).returning();
    const [a] = await db.insert(agents).values({
      name: `rate-agent-${S}`,
      tokenHash: `h-${S}`,
      serviceUserId: u.id,
      gitAuthorName: `rate-agent-${S}`,
      gitAuthorEmail: `rate-agent-${S}@t.co`,
    }).returning();
    agentId = a.id;
  });

  it("bumpUsage returns strictly increasing values and never loses a concurrent update", async () => {
    const N = 50;
    // Fire N increments concurrently. With a lost-update race the returned values
    // collide and the final persisted count lands below N; the atomic version
    // returns N distinct values 1..N and persists exactly N.
    const results = await Promise.all(Array.from({ length: N }, () => bumpUsage(db, agentId, "api")));
    const unique = new Set(results);
    expect(unique.size).toBe(N);
    expect(Math.max(...results)).toBe(N);
    expect(Math.min(...results)).toBe(1);
    expect(await currentUsage(db, agentId, "api")).toBe(N);
  });

  it("enforceRate throttles at the quota even under a concurrent burst", async () => {
    const limit = 10;
    await upsertQuota(db, agentId, { pushPerHour: limit });

    // 40 concurrent push attempts against a limit of 10. Exactly `limit` must be
    // admitted; the rest must be rejected with agent_rate_limited. A lost-update
    // race would under-count and admit far more than the limit.
    const attempts = 40;
    const settled = await Promise.allSettled(
      Array.from({ length: attempts }, () => enforceRate(db, agentId, "push")),
    );
    const admitted = settled.filter(s => s.status === "fulfilled").length;
    const rejected = settled.filter(
      s => s.status === "rejected" && (s.reason as ForbiddenError)?.message?.startsWith("agent_rate_limited:push"),
    ).length;

    expect(admitted).toBe(limit);
    expect(rejected).toBe(attempts - limit);

    // The persisted counter reflects every attempt (one atomic bump each), so it
    // equals the total number of calls — proving no bump was silently dropped.
    const persisted = (await db.select().from(agentUsage)
      .where(and(eq(agentUsage.agentId, agentId), eq(agentUsage.kind, "push")))
      .limit(1))[0];
    expect(persisted?.count).toBe(attempts);
  });
});
