import { describe, it, expect } from "vitest";
import {
  scopeKeyOf, readScopeKeys, recency, heuristicCeiling, effectiveImportance,
  lexicalRelevance, rankMemories, memoryTrigrams, type RankContext,
} from "../src/services/memory-index.js";
import type { AgentMemory } from "../src/models/schema.js";

function mem(p: Partial<AgentMemory>): AgentMemory {
  return {
    id: "m", scope: "agent_repo", scopeKey: "agent_repo:a:r", agentId: "a", repoId: "r", orgId: null,
    kind: "convention", title: "t", body: "b", facts: {}, tags: [], importance: 3, confidence: 50,
    trigrams: [], embedding: null, embeddingModel: null,
    validFrom: new Date(), validTo: null, supersedesId: null,
    useCount: 0, lastUsedAt: new Date(), pinned: false, expiresAt: null, archivedAt: null,
    sourceRunId: null, createdByAgentId: "a", quarantinedAt: null, reviewedBy: null, reviewedAt: null,
    createdAt: new Date(), ...p,
  } as AgentMemory;
}

describe("scope keys", () => {
  it("builds the right write key per scope", () => {
    expect(scopeKeyOf("agent_repo", { agentId: "a", repoId: "r" })).toBe("agent_repo:a:r");
    expect(scopeKeyOf("repo", { repoId: "r" })).toBe("repo:r");
    expect(scopeKeyOf("agent", { agentId: "a" })).toBe("agent:a");
    expect(scopeKeyOf("org", { orgId: "o" })).toBe("org:o");
  });
  it("reads the full scope union for a run", () => {
    expect(readScopeKeys({ agentId: "a", repoId: "r", orgId: "o" })).toEqual(["agent_repo:a:r", "repo:r", "agent:a", "org:o"]);
    // No org → no org key. Order is load-bearing (most-specific first).
    expect(readScopeKeys({ agentId: "a", repoId: "r" })).toEqual(["agent_repo:a:r", "repo:r", "agent:a"]);
  });
});

describe("recency", () => {
  const now = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  it("is ~1 for a just-used memory and decays over time", () => {
    expect(recency(now, now)).toBeCloseTo(1, 5);
    const dayAgo = new Date(now.getTime() - 24 * 3600_000);
    expect(recency(dayAgo, now)).toBeLessThan(1);
    expect(recency(dayAgo, now)).toBeGreaterThan(0.8); // 0.995^24 ≈ 0.886
    const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
    expect(recency(weekAgo, now)).toBeLessThan(recency(dayAgo, now));
  });
});

describe("importance floor (anti-gaming)", () => {
  it("caps a self-rating at the deterministic ceiling", () => {
    // An ungrounded, unused episode self-rated 10 is capped low.
    const c = heuristicCeiling({ kind: "episode", facts: {}, useCount: 0 }, 0);
    expect(c).toBeLessThan(10);
    expect(effectiveImportance(10, c)).toBe(c);
  });
  it("rewards grounded, novel, proven-useful memories", () => {
    const grounded = heuristicCeiling({ kind: "decision", facts: { changeId: "c1" }, useCount: 3 }, 1);
    const bare = heuristicCeiling({ kind: "episode", facts: {}, useCount: 0 }, 0);
    expect(grounded).toBeGreaterThan(bare);
  });
  it("never lets the floor exceed the self-rating", () => {
    expect(effectiveImportance(2, 9)).toBe(2);
  });
});

describe("lexicalRelevance", () => {
  it("is the fraction of query trigrams present", () => {
    const q = memoryTrigrams("rate limit", "");
    const m = memoryTrigrams("the rate limit is 100/min", "");
    expect(lexicalRelevance(q, m)).toBeGreaterThan(0.5);
    expect(lexicalRelevance(q, memoryTrigrams("completely unrelated text", ""))).toBeLessThan(0.5);
  });
});

describe("rankMemories", () => {
  const now = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));
  const ctx = (over: Partial<RankContext> = {}): RankContext => ({ queryTrigrams: [], now, ownAgentId: "a", ...over });

  it("floats pinned memories to the very top", () => {
    const a = mem({ id: "a", importance: 9, lastUsedAt: now });
    const pinned = mem({ id: "p", importance: 1, pinned: true, lastUsedAt: new Date(now.getTime() - 1e9) });
    const ranked = rankMemories([a, pinned], ctx());
    expect(ranked[0].memory.id).toBe("p");
  });

  it("ranks a recent, relevant, important memory above a stale irrelevant one", () => {
    const q = memoryTrigrams("database migration", "");
    const hit = mem({ id: "hit", title: "database migration runbook", trigrams: memoryTrigrams("database migration runbook", ""), importance: 8, lastUsedAt: now });
    const miss = mem({ id: "miss", title: "lunch preferences", trigrams: memoryTrigrams("lunch preferences", ""), importance: 2, lastUsedAt: new Date(now.getTime() - 30 * 24 * 3600_000) });
    const ranked = rankMemories([hit, miss], ctx({ queryTrigrams: q }));
    expect(ranked[0].memory.id).toBe("hit");
  });

  it("down-weights another agent's memory vs your own (all else equal)", () => {
    const mine = mem({ id: "mine", createdByAgentId: "a", importance: 5, lastUsedAt: now, trigrams: memoryTrigrams("shared topic", "") });
    const theirs = mem({ id: "theirs", createdByAgentId: "b", importance: 5, lastUsedAt: now, trigrams: memoryTrigrams("shared topic", "") });
    const ranked = rankMemories([mine, theirs], ctx({ queryTrigrams: memoryTrigrams("shared topic", "") }));
    const myScore = ranked.find(r => r.memory.id === "mine")!.score;
    const theirScore = ranked.find(r => r.memory.id === "theirs")!.score;
    expect(myScore).toBeGreaterThan(theirScore);
  });

  it("returns [] for no candidates", () => {
    expect(rankMemories([], ctx())).toEqual([]);
  });

  it("does NOT float an ungrounded self-rated decision (anti-gaming)", () => {
    // A bare decision (no changeId, not reviewed) must not auto-top a relevant convention.
    const q = memoryTrigrams("deploy process", "");
    const bareDecision = mem({ id: "d", kind: "decision", importance: 5, lastUsedAt: new Date(now.getTime() - 1e9), trigrams: memoryTrigrams("unrelated chatter", ""), facts: {}, reviewedBy: null });
    const relevant = mem({ id: "c", kind: "convention", importance: 8, lastUsedAt: now, trigrams: memoryTrigrams("deploy process runbook", "") });
    const ranked = rankMemories([bareDecision, relevant], ctx({ queryTrigrams: q }));
    expect(ranked[0].memory.id).toBe("c");
  });
  it("floats a grounded decision (has changeId)", () => {
    const grounded = mem({ id: "d", kind: "decision", importance: 5, lastUsedAt: new Date(now.getTime() - 1e9), trigrams: [], facts: { changeId: "ch1" } });
    const other = mem({ id: "o", kind: "convention", importance: 9, lastUsedAt: now, trigrams: [] });
    const ranked = rankMemories([grounded, other], ctx());
    expect(ranked[0].memory.id).toBe("d");
  });
});
