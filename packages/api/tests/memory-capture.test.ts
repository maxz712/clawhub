import { describe, it, expect } from "vitest";
import { firstFailingStep, normalizeFingerprint } from "../src/services/memory-capture.js";
import { quietDue } from "../src/services/standing-agents.js";

describe("normalizeFingerprint", () => {
  it("lowercases, collapses non-alnum runs, trims, caps", () => {
    expect(normalizeFingerprint("ci", "Unit Tests (fast)")).toBe("ci:unit-tests-fast");
    expect(normalizeFingerprint("rollback", "  Webhook 401s spiked!!  ")).toBe("rollback:webhook-401s-spiked");
    expect(normalizeFingerprint("ci", "x".repeat(200)).length).toBeLessThanOrEqual(64);
  });
  it("returns empty for content-free input (caller skips the fact)", () => {
    expect(normalizeFingerprint("ci", "!!!")).toBe("");
    expect(normalizeFingerprint("ci", "")).toBe("");
  });
});

describe("firstFailingStep", () => {
  it("finds status-style and ok-style failures", () => {
    expect(firstFailingStep([{ name: "lint", status: "success" }, { name: "unit tests", status: "failure" }])).toBe("unit tests");
    expect(firstFailingStep([{ name: "boot", ok: true }, { name: "e2e", ok: false }])).toBe("e2e");
  });
  it("tolerates junk shapes", () => {
    expect(firstFailingStep(undefined)).toBe("");
    expect(firstFailingStep([null, "x", { status: "failure" }] as unknown[])).toBe("unnamed-step");
    expect(firstFailingStep([{ name: "all good", status: "success" }])).toBe("");
  });
});

describe("quietDue (debounce-until-quiet reflect trigger)", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);
  const QUIET = 2 * 3600; // 2h settle window

  it("fires when activity happened since the last run and has settled", () => {
    expect(quietDue(hoursAgo(3), hoursAgo(10), QUIET, now)).toBe(true);
    expect(quietDue(hoursAgo(3), null, QUIET, now)).toBe(true); // never run yet
  });
  it("does not fire while activity is still fresh (debounce)", () => {
    expect(quietDue(hoursAgo(1), hoursAgo(10), QUIET, now)).toBe(false);
  });
  it("does not re-fire when nothing new happened since the last run", () => {
    expect(quietDue(hoursAgo(5), hoursAgo(4), QUIET, now)).toBe(false);
  });
  it("never fires on a repo with no activity at all", () => {
    expect(quietDue(null, null, QUIET, now)).toBe(false);
  });
  it("honors the failure-backoff hold", () => {
    expect(quietDue(hoursAgo(3), hoursAgo(10), QUIET, now, new Date(now.getTime() + 60_000))).toBe(false);
  });
});
