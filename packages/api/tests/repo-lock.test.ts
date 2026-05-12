import { describe, it, expect } from "vitest";
import { advisoryLockKey } from "../src/services/repo-lock.js";

describe("advisoryLockKey", () => {
  it("is deterministic for the same (repoId, branch)", () => {
    const k1 = advisoryLockKey("repo-1", "main");
    const k2 = advisoryLockKey("repo-1", "main");
    expect(k1).toBe(k2);
  });

  it("differs across branches in the same repo", () => {
    const a = advisoryLockKey("repo-1", "main");
    const b = advisoryLockKey("repo-1", "feature/x");
    expect(a).not.toBe(b);
  });

  it("differs across repos for the same branch", () => {
    const a = advisoryLockKey("repo-1", "main");
    const b = advisoryLockKey("repo-2", "main");
    expect(a).not.toBe(b);
  });

  it("stays within signed bigint range", () => {
    const k = advisoryLockKey("anything", "anything");
    expect(k >= 0n).toBe(true);
    expect(k <= 0x7fffffffffffffffn).toBe(true);
  });
});
