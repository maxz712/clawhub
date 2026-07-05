import { describe, it, expect } from "vitest";
import {
  PRIORITY,
  ciPriorityClass,
  agentPriorityClass,
  agentResourceRequest,
  ciResourceRequest,
  effectivePriority,
  fits,
  residualScore,
  shouldRetry,
  type NodeCapacity,
  type ResourceRequest,
} from "../src/services/job-scheduling.js";

describe("priority bands", () => {
  it("CI outranks every agent mode", () => {
    expect(ciPriorityClass("push")).toBe(PRIORITY.ci);
    expect(ciPriorityClass("merge")).toBe(PRIORITY.deploy);
    expect(ciPriorityClass("schedule", true)).toBe(PRIORITY.deploy);
    // the highest agent band (verify) is still below on:push CI
    expect(agentPriorityClass("verify")).toBeLessThan(ciPriorityClass("push"));
  });

  it("maps agent modes to descending bands", () => {
    expect(agentPriorityClass("verify")).toBe(PRIORITY.verify);
    expect(agentPriorityClass("review")).toBe(PRIORITY.review);
    expect(agentPriorityClass("develop")).toBe(PRIORITY.develop);
    expect(agentPriorityClass("worker")).toBe(PRIORITY.develop);
    expect(agentPriorityClass("scout")).toBe(PRIORITY.scout);
    expect(agentPriorityClass("triage")).toBe(PRIORITY.scout);
    expect(agentPriorityClass(null)).toBe(PRIORITY.scout);
  });
});

describe("aging (anti-starvation)", () => {
  const t0 = new Date("2026-07-05T00:00:00Z");
  const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

  it("a fresh CI run outranks a fresh scout run", () => {
    const ci = effectivePriority(PRIORITY.ci, t0, t0);
    const scout = effectivePriority(PRIORITY.scout, t0, t0);
    expect(ci).toBeGreaterThan(scout);
  });

  it("a long-waiting scout eventually reaches (but not exceeds) the CI band", () => {
    // Defaults (+1 per 6s, cap 400): after ~45 min a scout (100) climbs the full 400
    // → 500 = the on:push-CI band, crossing a fresh review/develop but not deploy.
    const scoutAged = effectivePriority(PRIORITY.scout, t0, at(45));
    const freshDeploy = effectivePriority(PRIORITY.deploy, at(45), at(45));
    const freshReview = effectivePriority(PRIORITY.review, at(45), at(45));
    expect(scoutAged).toBeGreaterThan(freshReview); // no permanent starvation
    expect(scoutAged).toBeLessThanOrEqual(PRIORITY.ci); // reaches the CI band
    expect(scoutAged).toBeLessThan(freshDeploy); // deploy stays uncontestable
  });

  it("aging is monotonic and capped at the CI band", () => {
    const a = effectivePriority(PRIORITY.scout, t0, at(5));
    const b = effectivePriority(PRIORITY.scout, t0, at(20));
    const c = effectivePriority(PRIORITY.scout, t0, at(600)); // 10 h — well past the cap
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThanOrEqual(b);
    // capped: climbs at most MAX_AGE_CLIMB (400), i.e. exactly to the CI band, never above
    expect(c).toBe(PRIORITY.ci);
    expect(c - PRIORITY.scout).toBeLessThanOrEqual(PRIORITY.ci - PRIORITY.scout);
  });
});

describe("placement — fits + worst-fit spread", () => {
  const node = (over: Partial<NodeCapacity>): NodeCapacity => ({
    nodeId: "n", cpusTotal: 4, memTotalMb: 8192, cpusFree: 4, memFreeMb: 8192, ...over,
  });
  const req: ResourceRequest = { cpus: 2, memoryMb: 2048, timeoutSec: 900 };

  it("rejects a node without enough cpu or mem", () => {
    expect(fits(node({ cpusFree: 1 }), req)).toBe(false);
    expect(fits(node({ memFreeMb: 1024 }), req)).toBe(false);
    expect(fits(node({}), req)).toBe(true);
  });

  it("keeps a headroom floor (won't starve a node to exactly 0)", () => {
    // memFree just above the request but below the request+MIN_FREE_MB floor.
    expect(fits(node({ memFreeMb: 2048 + 200 }), req)).toBe(false);
    expect(fits(node({ memFreeMb: 2048 + 1000 }), req)).toBe(true);
  });

  it("honors an arch pin", () => {
    expect(fits(node({ arch: "arm64" }), req, "amd64")).toBe(false);
    expect(fits(node({ arch: "x64" }), req, "amd64")).toBe(true);
    expect(fits(node({ arch: "arm64" }), req, null)).toBe(true); // no pin = any
  });

  it("worst-fit prefers the emptier node (spread)", () => {
    const busy = node({ nodeId: "busy", cpusFree: 3, memFreeMb: 4096 });
    const idle = node({ nodeId: "idle", cpusFree: 12, memTotalMb: 16384, memFreeMb: 15000, cpusTotal: 12 });
    expect(residualScore(idle, req)).toBeGreaterThan(residualScore(busy, req));
  });
});

describe("resource requests", () => {
  it("CI defaults to the 3GB tsc floor; deploy is lean", () => {
    expect(ciResourceRequest("push").memoryMb).toBe(3072);
    expect(ciResourceRequest("merge").cpus).toBe(1);
  });

  it("an agent's operator-set limits win over the mode default", () => {
    const r = agentResourceRequest({ mode: "develop", memoryMb: 4096, cpus: 2, timeoutSec: 5400 }, null);
    expect(r.memoryMb).toBe(4096);
    expect(r.cpus).toBe(2);
  });

  it("a verify tier records itself for placement", () => {
    const r = agentResourceRequest({ mode: "verify", memoryMb: null, cpus: null, timeoutSec: null }, "services");
    expect(r.tier).toBe("services");
  });
});

describe("retry policy", () => {
  it("retries a stuck run within budget, never a genuine failure/supersede", () => {
    expect(shouldRetry("stuck", 0, 2)).toBe(true); // attempt 0 → retry (1 < 2)
    expect(shouldRetry("stuck", 1, 2)).toBe(false); // budget exhausted (2 == 2)
    expect(shouldRetry("failed", 0, 5)).toBe(false);
    expect(shouldRetry("superseded", 0, 5)).toBe(false);
    expect(shouldRetry("stale", 0, 5)).toBe(false);
  });
});
