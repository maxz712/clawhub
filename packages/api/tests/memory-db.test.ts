import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import { agentMemories, agents, ciRuns, memoryEdges, repositories } from "../src/models/schema.js";
import {
  batchWriteMemory, buildMemoryPack, searchMemory, writeMemory, type ScopeIds,
} from "../src/services/memory.js";

// DB-backed integration tests for the memory retrieval path. The pure ranking
// math is covered in memory.test.ts — but the DB path (candidateMemories /
// searchMemory / buildMemoryPack) shipped with a crash-on-every-call bug
// (drizzle+postgres-js cannot serialize a raw Date inside a sql`` fragment)
// precisely because nothing exercised it against a real Postgres. These tests
// only run when CLAWHUB_TEST_DATABASE_URL is set (CI or a local dev DB with the
// schema pushed); they are skipped otherwise so the default suite stays pure.
//
//   CLAWHUB_TEST_DATABASE_URL=postgresql://me@localhost:5432/clawhub_test npx vitest run tests/memory-db.test.ts

const TEST_URL = process.env.CLAWHUB_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("memory DB integration", () => {
  const client = TEST_URL ? postgres(TEST_URL, { max: 2 }) : null!;
  const db = TEST_URL ? drizzle(client, { schema }) : null!;
  let ids: ScopeIds;
  let runId: string;

  beforeAll(async () => {
    const [agent] = await db.insert(agents).values({
      name: `memdb-test-${Date.now()}`, tokenHash: "x",
      gitAuthorName: "memdb-test", gitAuthorEmail: "memdb-test@test.local",
    }).returning();
    const [repo] = await db.insert(repositories).values({
      name: `memdb-test-${Date.now()}`, namespaceType: "user", namespaceId: agent.id,
    }).returning();
    const [run] = await db.insert(ciRuns).values({ repoId: repo.id, runnerToken: "t-memdb" }).returning();
    ids = { agentId: agent.id, repoId: repo.id, orgId: null };
    runId = run.id;
  });

  afterAll(async () => {
    if (!ids) { await client?.end(); return; }
    // repo cascade removes memories + edges + runs; agent row last.
    await db.delete(repositories).where(eq(repositories.id, ids.repoId));
    await db.delete(agents).where(eq(agents.id, ids.agentId));
    await client.end();
  });

  it("writeMemory → searchMemory round-trips without crashing (Date-param regression)", async () => {
    const row = await writeMemory(db, ids, {
      kind: "convention",
      title: "webhook signatures need a length guard",
      body: "timingSafeEqual throws on unequal buffer lengths — guard first.",
      facts: { paths: ["src/billing/stripe-webhook.ts"] },
      importance: 7,
    });
    expect(row).not.toBeNull();
    // The exact call shape that crashed in prod: default `now`, no asOf.
    const hits = await searchMemory(db, ids, { query: "webhook signature length guard" });
    expect(hits.map(h => h.id)).toContain(row!.id);
  });

  it("point-in-time (asOf) reads exercise the validTo comparison", async () => {
    const hits = await searchMemory(db, ids, { asOf: new Date() });
    expect(Array.isArray(hits)).toBe(true);
  });

  it("facts.paths materialize into derived `about` edges on write", async () => {
    const row = await writeMemory(db, ids, {
      kind: "failure",
      title: "invoice rounding drifts on fractional qty",
      body: "Multiply in integer micro-units, round once at the end.",
      facts: { paths: ["src/billing/invoice.ts"], errorFingerprint: "invoice-float-drift" },
    });
    const edges = await db.select().from(memoryEdges).where(eq(memoryEdges.srcMemoryId, row!.id));
    expect(edges.some(e => e.relation === "about" && e.dstPath === "src/billing/invoice.ts")).toBe(true);
  });

  it("diff-conditioned retrieval ranks path-relevant memories first", async () => {
    await writeMemory(db, ids, {
      kind: "decision",
      title: "unrelated auth decision",
      body: "Sessions stay at 7-day TTL.",
      facts: { paths: ["src/auth/session.ts"], changeId: crypto.randomUUID() },
      importance: 8,
    });
    const hits = await searchMemory(db, ids, { changedPaths: ["src/billing/stripe-webhook.ts"] });
    expect(hits[0]?.title).toBe("webhook signatures need a length guard");
  });

  it("retrieval bumps use_count (the survival signal)", async () => {
    const before = (await db.select().from(agentMemories).where(eq(agentMemories.scopeKey, `agent_repo:${ids.agentId}:${ids.repoId}`)));
    const hits = await searchMemory(db, ids, { query: "webhook signature length guard" });
    const hit = hits.find(h => h.title === "webhook signatures need a length guard")!;
    const prior = before.find(b => b.id === hit.id)!;
    const [after] = await db.select().from(agentMemories).where(eq(agentMemories.id, hit.id));
    expect(after.useCount).toBeGreaterThan(prior.useCount);
  });

  it("buildMemoryPack returns a parseable, conditioned pack", async () => {
    const packRaw = await buildMemoryPack(db, ids, { changedPaths: ["src/billing/stripe-webhook.ts"] });
    const pack = JSON.parse(packRaw) as { version: number; memories: Array<{ id: string; kind: string; title: string }> };
    expect(pack.version).toBeGreaterThanOrEqual(1);
    expect(pack.memories.length).toBeGreaterThan(0);
    expect(pack.memories[0].title).toBe("webhook signatures need a length guard");
  });

  it("batch writes are idempotent on sourceRunId", async () => {
    const items = [{ kind: "episode", title: "run summary", body: "did a thing" }];
    const first = await batchWriteMemory(db, ids, items, runId);
    const second = await batchWriteMemory(db, ids, items, runId);
    expect(first.written).toBe(1);
    expect(second.written).toBe(0);
    const rows = await db.select().from(agentMemories)
      .where(inArray(agentMemories.sourceRunId, [runId]));
    expect(rows.length).toBe(1);
  });
});
