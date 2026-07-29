import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../src/models/schema.js";
import { agentMemories, agents, killSwitches, repositories } from "../src/models/schema.js";
import { runMemoryDecaySweep } from "../src/services/memory-decay.js";

// DB-backed regression for #91: memory decay must NOT hard-delete a quarantined
// row while its owning agent's kill-switch is still engaged. Quarantine is an
// investigative HOLD (kill-switch engage stamps quarantinedAt; disengage clears
// it — services/kill-switch.ts), not a 30-day TTL. An unrelated circuit-breaker
// auto-pause would otherwise auto-shred an in-flight incident's evidence.
//
// Same gating as memory-db.test.ts: runs only against a real Postgres with the
// schema pushed, skipped otherwise so the default pure suite stays fast.
//   CLAWHUB_TEST_DATABASE_URL=postgresql://me@localhost:5432/clawhub_test npx vitest run tests/memory-decay.test.ts

const TEST_URL = process.env.CLAWHUB_TEST_DATABASE_URL;
const DAY = 24 * 3600_000;

describe.skipIf(!TEST_URL)("memory decay — quarantine preservation (#91)", () => {
  const client = TEST_URL ? postgres(TEST_URL, { max: 2 }) : null!;
  const db = TEST_URL ? drizzle(client, { schema }) : null!;
  const stamp = Date.now();
  let killedAgentId: string, liveAgentId: string, repoId: string;
  let preservedMemId: string, prunableMemId: string, archivedMemId: string;

  beforeAll(async () => {
    const [killed] = await db.insert(agents).values({
      name: `decay-killed-${stamp}`, tokenHash: "x", gitAuthorName: "k", gitAuthorEmail: "k@test.local",
    }).returning();
    const [live] = await db.insert(agents).values({
      name: `decay-live-${stamp}`, tokenHash: "x", gitAuthorName: "l", gitAuthorEmail: "l@test.local",
    }).returning();
    const [repo] = await db.insert(repositories).values({
      name: `decay-test-${stamp}`, namespaceType: "user", namespaceId: killed.id,
    }).returning();
    killedAgentId = killed.id; liveAgentId = live.id; repoId = repo.id;

    // Kill-switch engaged for the killed agent only.
    await db.insert(killSwitches).values({ agentId: killedAgentId, reason: "suspected memory poisoning" });

    const old = new Date(stamp - 40 * DAY); // past the 30-day quarantine window
    const base = { scope: "repo" as const, scopeKey: `repo:${repo.id}`, repoId: repo.id, kind: "convention" as const, body: "x" };
    const [preserved] = await db.insert(agentMemories).values({ ...base, title: `preserved-${stamp}`, createdByAgentId: killedAgentId, quarantinedAt: old }).returning();
    const [prunable] = await db.insert(agentMemories).values({ ...base, title: `prunable-${stamp}`, createdByAgentId: liveAgentId, quarantinedAt: old }).returning();
    // A normal archived row past its grace window — must STILL prune (this fix is
    // scoped to the quarantined branch only; the archived path is unchanged).
    const [archived] = await db.insert(agentMemories).values({ ...base, title: `archived-${stamp}`, createdByAgentId: liveAgentId, archivedAt: old }).returning();
    preservedMemId = preserved.id; prunableMemId = prunable.id; archivedMemId = archived.id;
  });

  afterAll(async () => {
    if (!repoId) { await client?.end(); return; }
    await db.delete(repositories).where(eq(repositories.id, repoId)); // cascades memories
    await db.delete(killSwitches).where(inArray(killSwitches.agentId, [killedAgentId, liveAgentId]));
    await db.delete(agents).where(inArray(agents.id, [killedAgentId, liveAgentId]));
    await client.end();
  });

  it("preserves a >30d quarantined memory while its owning agent's kill-switch stays engaged", async () => {
    await runMemoryDecaySweep(db);
    const rows = await db.select({ id: agentMemories.id }).from(agentMemories)
      .where(inArray(agentMemories.id, [preservedMemId, prunableMemId, archivedMemId]));
    const live = new Set(rows.map(r => r.id));
    expect(live.has(preservedMemId)).toBe(true);  // kill-switch engaged → evidence held
    expect(live.has(prunableMemId)).toBe(false);  // owner not killed → pruned as before
    expect(live.has(archivedMemId)).toBe(false);  // archived prune path unaffected
  });

  it("prunes a once-quarantined memory after its owning agent's kill-switch is disengaged", async () => {
    const old = new Date(stamp - 40 * DAY);
    const [row] = await db.insert(agentMemories).values({
      scope: "repo", scopeKey: `repo:${repoId}`, repoId, kind: "convention",
      title: `postdisengage-${stamp}`, body: "x", createdByAgentId: killedAgentId, quarantinedAt: old,
    }).returning();
    // Drop the kill-switch (row still carries quarantinedAt — the edge case the
    // fix must let through once the hold is lifted).
    await db.delete(killSwitches).where(eq(killSwitches.agentId, killedAgentId));
    await runMemoryDecaySweep(db);
    const still = await db.select({ id: agentMemories.id }).from(agentMemories).where(eq(agentMemories.id, row.id));
    expect(still.length).toBe(0);
  });
});
