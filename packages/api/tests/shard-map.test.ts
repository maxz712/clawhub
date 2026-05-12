import { describe, it, expect } from "vitest";
import { consistentShardId } from "../src/services/shard-map.js";

describe("consistentShardId (HRW)", () => {
  it("returns null on empty shard set", () => {
    expect(consistentShardId("repo-1", [])).toBeNull();
  });

  it("is deterministic for the same inputs", () => {
    const shards = ["a", "b", "c"];
    const a = consistentShardId("repo-1", shards);
    const b = consistentShardId("repo-1", shards);
    expect(a).toBe(b);
  });

  it("distributes across shards reasonably (no shard gets all keys)", () => {
    const shards = ["a", "b", "c", "d"];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const s = consistentShardId(`repo-${i}`, shards)!;
      counts[s] = (counts[s] ?? 0) + 1;
    }
    // Each shard should get at least 5% of keys with a fair hash.
    for (const s of shards) expect(counts[s] ?? 0).toBeGreaterThan(50);
  });

  it("placement is stable across orderings of the shard list", () => {
    const a = consistentShardId("repo-x", ["a", "b", "c"]);
    const b = consistentShardId("repo-x", ["c", "b", "a"]);
    expect(a).toBe(b);
  });
});
