import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import { agentMemories, agents, ciRuns, memoryEdges, repositories } from "../src/models/schema.js";
import {
  batchWriteMemory, buildMemoryPack, bumpCitedMemories, searchMemory, superviseMemory, writeMemory, type ScopeIds,
} from "../src/services/memory.js";
import { captureChangeMerged, captureRollback } from "../src/services/memory-capture.js";
import { deriveCoChangeEdges } from "../src/services/memory-graph.js";
import { changes, users } from "../src/models/schema.js";

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

  it("agent shared-scope writes land pending, invisible until a human approves", async () => {
    const row = await writeMemory(db, ids, {
      kind: "convention", scope: "repo",
      title: "pending governance check", body: "shared writes need approval",
    }, { pendingForShared: true });
    expect(row!.pendingAt).not.toBeNull();
    const before = await searchMemory(db, ids, { query: "pending governance check" });
    expect(before.map(m => m.id)).not.toContain(row!.id);
    // asOf must not bypass the gate either.
    const asOf = await searchMemory(db, ids, { asOf: new Date() });
    expect(asOf.map(m => m.id)).not.toContain(row!.id);
    const [user] = await db.insert(users).values({ email: `memdb-${Date.now()}@t.local`, passwordHash: "x", username: `memdb${Date.now()}` }).returning();
    await superviseMemory(db, ids.repoId, row!.id, user.id, "approve");
    const after = await searchMemory(db, ids, { query: "pending governance check" });
    expect(after.map(m => m.id)).toContain(row!.id);
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("own-scope (agent_repo) writes are never pending", async () => {
    const row = await writeMemory(db, ids, {
      kind: "episode", title: "own scope stays live", body: "x",
    }, { pendingForShared: true });
    expect(row!.pendingAt).toBeNull();
  });

  it("supersedesIds consolidates a whole cluster into one row", async () => {
    const eps = [];
    for (let i = 0; i < 3; i++) {
      eps.push((await writeMemory(db, ids, {
        kind: "episode", title: `flaky auth test occurrence ${i}`, body: `auth.test.ts timed out (${i})`,
        facts: { errorFingerprint: "ci:auth-test-timeout" },
      }))!);
    }
    const consolidated = await writeMemory(db, ids, {
      kind: "failure", title: "auth.test.ts times out under parallel runs",
      body: "Cause: shared session fixture. Fix: isolate fixtures. Guardrail: never share sessions across tests.",
      supersedesIds: eps.map(e => e.id),
    });
    expect(consolidated).not.toBeNull();
    const old = await db.select().from(agentMemories).where(inArray(agentMemories.id, eps.map(e => e.id)));
    expect(old.every(o => o.validTo !== null)).toBe(true);
    expect(consolidated!.supersedesId).toBe(eps[0].id);
  });

  it("server capture is idempotent on (scope, kind, title)", async () => {
    const ch = { id: crypto.randomUUID(), repoId: ids.repoId, intent: "test rollback capture", branch: "b", changedPaths: ["src/a.ts"], openedByAgentId: ids.agentId };
    await captureRollback(db, ch, { reason: "broke prod" });
    await captureRollback(db, ch, { reason: "broke prod" });
    const rows = await db.select().from(agentMemories).where(eq(agentMemories.scopeKey, `repo:${ids.repoId}`));
    expect(rows.filter(r => r.title.startsWith("Rolled back:")).length).toBe(1);
    const cap = rows.find(r => r.title.startsWith("Rolled back:"))!;
    expect(cap.kind).toBe("failure");
    expect((cap.facts as { errorFingerprint?: string }).errorFingerprint).toContain("rollback:");
  });

  it("rollback supersedes the prior live 'Change merged' episode for the same change (no contradictory pair)", async () => {
    const ch = { id: crypto.randomUUID(), repoId: ids.repoId, intent: "ship the billing fix", branch: "b2", changedPaths: ["src/b.ts"], openedByAgentId: ids.agentId };
    await captureChangeMerged(db, ch, { actorName: "alice" });
    const merged = (await db.select().from(agentMemories)
      .where(and(eq(agentMemories.scopeKey, `repo:${ids.repoId}`), eq(agentMemories.kind, "episode")))).find(r => r.title.includes(ch.id.slice(0, 8)))!;
    expect(merged.validTo).toBeNull();

    await captureRollback(db, ch, { reason: "broke billing" });

    const [mergedAfter] = await db.select().from(agentMemories).where(eq(agentMemories.id, merged.id));
    expect(mergedAfter.validTo).not.toBeNull(); // retired, not left live alongside the rollback

    const rollbackRow = (await db.select().from(agentMemories)
      .where(and(eq(agentMemories.scopeKey, `repo:${ids.repoId}`), eq(agentMemories.kind, "failure"))))
      .find(r => r.title.includes(ch.id.slice(0, 8)))!;
    expect(rollbackRow.supersedesId).toBe(merged.id);

    // The live view for this change now shows only the rollback outcome.
    const live = await db.select().from(agentMemories)
      .where(and(eq(agentMemories.scopeKey, `repo:${ids.repoId}`), isNull(agentMemories.validTo)));
    const liveForChange = live.filter(r => r.title.includes(ch.id.slice(0, 8)));
    expect(liveForChange.length).toBe(1);
    expect(liveForChange[0].id).toBe(rollbackRow.id);
  });

  it("rollback capture is a plain add (no supersede) when no live merged episode exists for the change", async () => {
    const ch = { id: crypto.randomUUID(), repoId: ids.repoId, intent: "never had a merge episode", branch: "b3", changedPaths: [], openedByAgentId: ids.agentId };
    await captureRollback(db, ch, { reason: "n/a" });
    const rollbackRow = (await db.select().from(agentMemories)
      .where(and(eq(agentMemories.scopeKey, `repo:${ids.repoId}`), eq(agentMemories.kind, "failure"))))
      .find(r => r.title.includes(ch.id.slice(0, 8)))!;
    expect(rollbackRow.supersedesId).toBeNull();
  });

  it("citation bump cannot resurrect an archived (human-vetoed) memory", async () => {
    const row = (await writeMemory(db, ids, {
      kind: "convention", scope: "repo", title: "vetoed shared note", body: "wrong advice",
    }))!;
    const [user] = await db.insert(users).values({ email: `veto-${Date.now()}@t.local`, passwordHash: "x", username: `veto${Date.now()}` }).returning();
    await superviseMemory(db, ids.repoId, row.id, user.id, "archive");
    const bumped = await bumpCitedMemories(db, ids, [row.id, `mem:${row.id}`]);
    expect(bumped).toBe(0);
    const [after] = await db.select().from(agentMemories).where(eq(agentMemories.id, row.id));
    expect(after.archivedAt).not.toBeNull();
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("citation bump tolerates junk and mem:-prefixed ids", async () => {
    const live = (await writeMemory(db, ids, { kind: "episode", title: "citable note", body: "x" }))!;
    const bumped = await bumpCitedMemories(db, ids, [`mem:${live.id}`, "not-a-uuid", "mem:also-junk", ""]);
    expect(bumped).toBe(1);
  });

  it("pending shared supersede defers retirement until human approval", async () => {
    // Platform-captured raw episodes (createdByAgentId null) — the consolidation material.
    const priors = [];
    for (let i = 0; i < 2; i++) {
      priors.push((await writeMemory(db, { agentId: null, repoId: ids.repoId, orgId: null }, {
        kind: "episode", scope: "repo", title: `captured raw episode ${i}`, body: `raw ${i}`,
      }))!);
    }
    // Agent consolidates via the pending shared-scope path (as the batch route would).
    const replacement = (await writeMemory(db, ids, {
      kind: "convention", scope: "repo", title: "distilled from captures", body: "the durable lesson",
      supersedesIds: priors.map(p => p.id),
    }, { pendingForShared: true }))!;
    expect(replacement.pendingAt).not.toBeNull();
    // Priors stay LIVE while the replacement is pending (no knowledge gap).
    const stillLive = await db.select().from(agentMemories).where(inArray(agentMemories.id, priors.map(p => p.id)));
    expect(stillLive.every(p => p.validTo === null)).toBe(true);
    // Client-supplied pendingSupersedes must have been server-controlled, not echoed.
    expect((replacement.facts as { pendingSupersedes?: string[] }).pendingSupersedes).toEqual(priors.map(p => p.id));
    // Approval releases the replacement AND retires the cluster.
    const [user] = await db.insert(users).values({ email: `appr-${Date.now()}@t.local`, passwordHash: "x", username: `appr${Date.now()}` }).returning();
    const approved = await superviseMemory(db, ids.repoId, replacement.id, user.id, "approve");
    expect(approved.pendingAt).toBeNull();
    expect((approved.facts as { pendingSupersedes?: unknown }).pendingSupersedes).toBeUndefined();
    const retired = await db.select().from(agentMemories).where(inArray(agentMemories.id, priors.map(p => p.id)));
    expect(retired.every(p => p.validTo !== null)).toBe(true);
    await db.delete(users).where(eq(users.id, user.id));
  });

  it("client-supplied facts.pendingSupersedes is stripped (no smuggled retirement)", async () => {
    const victim = (await writeMemory(db, { agentId: null, repoId: ids.repoId, orgId: null }, {
      kind: "episode", scope: "repo", title: "innocent bystander", body: "x",
    }))!;
    const row = (await writeMemory(db, ids, {
      kind: "episode", scope: "repo", title: "smuggler", body: "x",
      facts: { pendingSupersedes: [victim.id] },
    }, { pendingForShared: true }))!;
    expect((row.facts as { pendingSupersedes?: unknown }).pendingSupersedes).toBeUndefined();
  });

  it("rejects non-object facts and non-array tags at the door", async () => {
    await expect(writeMemory(db, ids, { kind: "episode", title: "bad facts", body: "x", facts: ["src/a.ts"] as unknown as Record<string, unknown> })).rejects.toThrow(/facts/);
    await expect(writeMemory(db, ids, { kind: "episode", title: "bad tags", body: "x", tags: "oops" as unknown as string[] })).rejects.toThrow(/tags/);
  });

  it("deriveCoChangeEdges links memories about co-changing paths", async () => {
    // Two merged changes both touching a.ts + b.ts → the pair co-changes twice.
    for (let i = 0; i < 2; i++) {
      await db.insert(changes).values({
        repoId: ids.repoId, branch: `cc-${i}`, headCommit: `c${i}`.padEnd(8, "0"),
        intent: "co-change fixture", status: "merged", changedPaths: ["src/cc/a.ts", "src/cc/b.ts"],
      });
    }
    const ma = (await writeMemory(db, ids, { kind: "convention", title: "about a.ts", body: "x", facts: { paths: ["src/cc/a.ts"] } }))!;
    const mb = (await writeMemory(db, ids, { kind: "convention", title: "about b.ts", body: "x", facts: { paths: ["src/cc/b.ts"] } }))!;
    const { written } = await deriveCoChangeEdges(db, ids.repoId);
    expect(written).toBeGreaterThan(0);
    const edges = await db.select().from(memoryEdges)
      .where(eq(memoryEdges.srcMemoryId, ma.id));
    expect(edges.some(e => e.dstMemoryId === mb.id && e.relation === "relates_to" && e.origin === "derived")).toBe(true);
  });
});
