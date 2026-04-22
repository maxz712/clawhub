import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

// Rollout bucketing uses sha256(key:ident) & mod 100.
function bucketFor(key: string, ident: string): number {
  const h = createHash("sha256").update(`${key}:${ident}`).digest();
  return h.readUInt32BE(0) % 100;
}

describe("feature-flag bucketing", () => {
  it("is deterministic per (key, ident)", () => {
    const a = bucketFor("new-ui", "user-1");
    const b = bucketFor("new-ui", "user-1");
    expect(a).toBe(b);
  });

  it("distributes reasonably across idents", () => {
    const counts: Record<number, number> = {};
    for (let i = 0; i < 10_000; i++) {
      const bucket = bucketFor("x", `id-${i}`);
      counts[Math.floor(bucket / 10)] = (counts[Math.floor(bucket / 10)] ?? 0) + 1;
    }
    // Expect each of the 10 deciles to land within ±20% of 1000.
    for (let i = 0; i < 10; i++) {
      expect(counts[i]).toBeGreaterThan(800);
      expect(counts[i]).toBeLessThan(1200);
    }
  });
});
