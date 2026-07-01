import { describe, it, expect } from "vitest";
import { rankMemories, memoryTrigrams, type RankContext } from "../src/services/memory-index.js";
import {
  walkFrontiers, normalizePath, writeEdges, type AdjLink,
} from "../src/services/memory-graph.js";
import type { AgentMemory } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

const HOP_DECAY = 0.6; // mirror of the constant in memory-graph.ts

/** A static-graph adjacency fetcher: return every link whose `from` is in the frontier. */
function staticGraph(edges: AdjLink[]) {
  return async (ids: string[]) => edges.filter(e => ids.includes(e.from));
}

describe("walkFrontiers (pure graph walk)", () => {
  it("reaches 1-hop neighbors and removes seeds", async () => {
    const g = staticGraph([{ from: "A", nbr: "B", prop: 0.7 }, { from: "B", nbr: "C", prop: 0.7 }]);
    const p = await walkFrontiers(["A"], g, { hops: 1 });
    expect(p.get("B")).toBeCloseTo(0.7 * HOP_DECAY, 6);
    expect(p.has("C")).toBe(false); // C is 2 hops away
    expect(p.has("A")).toBe(false); // seeds removed
  });

  it("reaches 2-hop neighbors with compounded decay", async () => {
    const g = staticGraph([{ from: "A", nbr: "B", prop: 0.7 }, { from: "B", nbr: "C", prop: 0.7 }]);
    const p = await walkFrontiers(["A"], g, { hops: 2 });
    expect(p.get("B")).toBeCloseTo(0.7 * HOP_DECAY, 6);
    expect(p.get("C")).toBeCloseTo(0.7 * HOP_DECAY * 0.7 * HOP_DECAY, 6);
    // closer neighbor scores strictly higher than the farther one
    expect(p.get("B")!).toBeGreaterThan(p.get("C")!);
  });

  it("is cycle-safe (A→B→A terminates, seed not re-surfaced)", async () => {
    const g = staticGraph([{ from: "A", nbr: "B", prop: 0.8 }, { from: "B", nbr: "A", prop: 0.8 }]);
    const p = await walkFrontiers(["A"], g, { hops: 2 });
    expect(p.get("B")).toBeCloseTo(0.8 * HOP_DECAY, 6);
    expect(p.has("A")).toBe(false);
  });

  it("caps fanout to the strongest neighbors", async () => {
    const g = staticGraph([
      { from: "A", nbr: "n1", prop: 0.9 }, { from: "A", nbr: "n2", prop: 0.8 },
      { from: "A", nbr: "n3", prop: 0.7 }, { from: "A", nbr: "n4", prop: 0.6 },
    ]);
    const p = await walkFrontiers(["A"], g, { hops: 1, fanout: 2 });
    expect([...p.keys()].sort()).toEqual(["n1", "n2"]); // only the top-2 by prop
  });

  it("keeps the BEST path when a node is reachable multiple ways", async () => {
    // A→D direct (strong) vs A→B→D (weak). D's proximity is the max, not the sum.
    const g = staticGraph([
      { from: "A", nbr: "D", prop: 0.9 }, { from: "A", nbr: "B", prop: 0.5 }, { from: "B", nbr: "D", prop: 0.9 },
    ]);
    const p = await walkFrontiers(["A"], g, { hops: 2 });
    expect(p.get("D")).toBeCloseTo(0.9 * HOP_DECAY, 6); // the direct path dominates
  });

  it("returns empty for disconnected seeds", async () => {
    const p = await walkFrontiers(["X"], staticGraph([{ from: "A", nbr: "B", prop: 0.7 }]), { hops: 2 });
    expect(p.size).toBe(0);
  });
});

describe("normalizePath", () => {
  it("strips leading ./ or / and trailing slashes and trims", () => {
    expect(normalizePath("./src/a/")).toBe("src/a");
    expect(normalizePath("/x/y")).toBe("x/y");
    expect(normalizePath("  a/b  ")).toBe("a/b");
    expect(normalizePath("pkg/file.ts")).toBe("pkg/file.ts");
  });
});

// --- ranking: the graph leg -------------------------------------------------

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

describe("rankMemories graph leg", () => {
  const now = new Date(Date.UTC(2026, 5, 20, 12, 0, 0));

  it("floats a graph-connected memory above an unconnected one, all else equal", () => {
    const connected = mem({ id: "conn", createdByAgentId: "a", lastUsedAt: now });
    const island = mem({ id: "isle", createdByAgentId: "a", lastUsedAt: now });
    const ctx: RankContext = { queryTrigrams: [], now, ownAgentId: "a", graphProximity: new Map([["conn", 0.8]]) };
    const ranked = rankMemories([island, connected], ctx);
    expect(ranked[0].memory.id).toBe("conn");
    expect(ranked.find(r => r.memory.id === "conn")!.legs.graph).toBeGreaterThan(ranked.find(r => r.memory.id === "isle")!.legs.graph);
  });

  it("is inert when no graphProximity is supplied (backward compatible)", () => {
    // Without a graph map the graph leg is 0 for all, so importance decides as before.
    const hi = mem({ id: "hi", importance: 9, lastUsedAt: now });
    const lo = mem({ id: "lo", importance: 2, lastUsedAt: now });
    const ranked = rankMemories([lo, hi], { queryTrigrams: [], now, ownAgentId: "a" });
    expect(ranked[0].memory.id).toBe("hi");
    for (const r of ranked) expect(r.legs.graph).toBe(0);
  });
});

// --- writeEdges validation (light fake DB, matching the repo's mock style) ---

function fakeDb(memRows: Array<{ id: string; scopeKey: string }>, capture?: { rows?: unknown[] }): DB {
  const thenable = (rows: unknown[]) => {
    const pr = Promise.resolve(rows) as Promise<unknown[]> & { limit?: (n: number) => Promise<unknown[]> };
    pr.limit = (n: number) => Promise.resolve(rows.slice(0, n));
    return pr;
  };
  return {
    select: () => ({ from: () => ({ where: () => thenable(memRows) }) }),
    insert: () => ({ values: (rows: unknown[]) => {
      if (capture) capture.rows = rows;
      return { onConflictDoNothing: () => ({ returning: () => Promise.resolve((rows as unknown[]).map((_, i) => ({ id: `e${i}` }))) }) };
    } }),
  } as unknown as DB;
}
const IDS = { agentId: "a", repoId: "r", orgId: null };

describe("writeEdges validation", () => {
  const inScope = [{ id: "src", scopeKey: "agent_repo:a:r" }, { id: "dst", scopeKey: "agent_repo:a:r" }];

  it("writes a mix of code + memory edges", async () => {
    const cap: { rows?: unknown[] } = {};
    const r = await writeEdges(fakeDb(inScope, cap), IDS, "src", [
      { relation: "about", dstPath: "src/x.ts" },
      { relation: "relates_to", dstMemoryId: "dst" },
    ]);
    expect(r.written).toBe(2);
    const rows = cap.rows as Array<{ dstKind: string; dstPath?: string; dstMemoryId?: string }>;
    expect(rows.map(x => x.dstKind).sort()).toEqual(["code", "memory"]);
  });

  it("rejects a self-loop", async () => {
    await expect(writeEdges(fakeDb(inScope), IDS, "src", [{ relation: "relates_to", dstMemoryId: "src" }]))
      .rejects.toThrow(/self-loop/);
  });

  it("rejects an unknown relation", async () => {
    await expect(writeEdges(fakeDb(inScope), IDS, "src", [{ relation: "bogus", dstMemoryId: "dst" }]))
      .rejects.toThrow(/invalid relation/);
  });

  it("requires a path for an about edge", async () => {
    await expect(writeEdges(fakeDb(inScope), IDS, "src", [{ relation: "about" }]))
      .rejects.toThrow(/requires dstPath/);
  });

  it("refuses a source memory outside the caller's scope", async () => {
    const outOfScope = [{ id: "src", scopeKey: "repo:OTHER" }];
    await expect(writeEdges(fakeDb(outOfScope), IDS, "src", [{ relation: "about", dstPath: "a.ts" }]))
      .rejects.toThrow(/outside your scope/);
  });
});
