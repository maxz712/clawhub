import { describe, it, expect } from "vitest";
import { ShardHealthMonitor } from "../src/services/shard-health.js";

// The monitor needs a DB but only for the periodic tick; the circuit-breaker
// logic is exercised directly via reportResult + canRequest.
const noopDb = { select: () => ({ from: () => Promise.resolve([]) }) } as never;

function makeMonitor(halfOpenAfterMs = 50) {
  return new ShardHealthMonitor(noopDb, {
    failThreshold: 3,
    halfOpenAfterMs,
    closeAfterSuccesses: 2,
  });
}

describe("ShardHealthMonitor circuit breaker", () => {
  it("starts closed and allows requests", () => {
    const m = makeMonitor();
    expect(m.getCircuit("a")).toBe("closed");
    expect(m.canRequest("a")).toBe(true);
  });

  it("opens after failThreshold consecutive failures", () => {
    // Long cooldown: this synchronous test asserts the circuit is OPEN and rejects
    // requests. With the default 50ms cooldown, a loaded CI runner can spend >50ms
    // between opening the circuit and the canRequest() check, letting the open→
    // half_open transition fire and admit a probe (canRequest → true) — a timing
    // flake that fails CI on every unrelated change. A 60s cooldown can't elapse
    // mid-test, so the assertion pins the OPEN behavior deterministically.
    const m = makeMonitor(60_000);
    m.reportResult("a", false);
    m.reportResult("a", false);
    expect(m.getCircuit("a")).toBe("closed");
    m.reportResult("a", false);
    expect(m.getCircuit("a")).toBe("open");
    expect(m.canRequest("a")).toBe(false);
  });

  it("transitions to half_open after the cooldown and closes after the required successes", async () => {
    const m = makeMonitor();
    m.reportResult("a", false);
    m.reportResult("a", false);
    m.reportResult("a", false);
    expect(m.canRequest("a")).toBe(false);
    await new Promise(r => setTimeout(r, 60));
    expect(m.canRequest("a")).toBe(true); // half-open admit
    expect(m.getCircuit("a")).toBe("half_open");
    m.reportResult("a", true);
    m.reportResult("a", true);
    expect(m.getCircuit("a")).toBe("closed");
  });

  it("reopens on a single failure in half_open", async () => {
    const m = makeMonitor();
    for (let i = 0; i < 3; i++) m.reportResult("a", false);
    await new Promise(r => setTimeout(r, 60));
    m.canRequest("a"); // transition to half_open
    m.reportResult("a", false);
    expect(m.getCircuit("a")).toBe("open");
  });

  it("counts a successful tick toward closing only in half_open", () => {
    const m = makeMonitor();
    m.reportResult("a", true);
    m.reportResult("a", true);
    m.reportResult("a", true);
    expect(m.getCircuit("a")).toBe("closed");
  });
});
