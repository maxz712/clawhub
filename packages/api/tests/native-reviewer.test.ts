import { describe, it, expect } from "vitest";
import { selectReviewModel, nativeReviewerDecision, validateNativeReviewContract } from "../src/services/native-reviewer.js";

describe("selectReviewModel", () => {
  const base = { changedPaths: ["src/app.ts"], authorRollbacks: 0, changeId: "c1", headCommit: "abc" };

  it("routes low/medium risk to Haiku", () => {
    expect(selectReviewModel({ ...base, effectiveRisk: "low" }).model).toBe("haiku");
    expect(selectReviewModel({ ...base, effectiveRisk: "medium" }).model).toBe("haiku");
  });
  it("routes high/critical risk to Sonnet", () => {
    expect(selectReviewModel({ ...base, effectiveRisk: "high" }).model).toBe("sonnet");
    expect(selectReviewModel({ ...base, effectiveRisk: "critical" }).model).toBe("sonnet");
  });
  it("floors a sensitive path to Sonnet even at low declared risk", () => {
    const sel = selectReviewModel({ ...base, effectiveRisk: "low", changedPaths: ["scripts/deploy.sh"] });
    expect(sel.model).toBe("sonnet");
    expect(sel.reason).toMatch(/sensitive path/);
  });
  it("bumps a level on author rollback history", () => {
    // medium + rollback → high → Sonnet
    expect(selectReviewModel({ ...base, effectiveRisk: "medium", authorRollbacks: 2 }).model).toBe("sonnet");
  });
  it("is deterministic — same change yields the same model", () => {
    const a = selectReviewModel({ ...base, effectiveRisk: "low" });
    const b = selectReviewModel({ ...base, effectiveRisk: "low" });
    expect(a).toEqual(b);
  });
  it("hash-seeded audit reproducibly promotes some low-risk changes to Sonnet", () => {
    // Sweep many ids; with 5% audit, at least one low-risk change should be audited
    // to Sonnet, and each decision is reproducible.
    let audited = 0;
    for (let i = 0; i < 400; i++) {
      const sel = selectReviewModel({ ...base, effectiveRisk: "low", changeId: `c${i}`, headCommit: `h${i}` });
      if (sel.audited) { audited++; expect(sel.model).toBe("sonnet"); }
    }
    expect(audited).toBeGreaterThan(0);
    expect(audited).toBeLessThan(120); // ~5% of 400, comfortably below a broken 30%
  });
});

describe("nativeReviewerDecision", () => {
  const on = { masterFlag: true, repoFlag: null, isDraft: false, hasByoReviewer: false, dailyCapReached: false };
  it("dispatches when the master flag is on and nothing suppresses it", () => {
    expect(nativeReviewerDecision(on).dispatch).toBe(true);
  });
  it("never dispatches on a draft", () => {
    expect(nativeReviewerDecision({ ...on, isDraft: true }).dispatch).toBe(false);
  });
  it("respects a repo hard opt-out", () => {
    expect(nativeReviewerDecision({ ...on, repoFlag: false }).dispatch).toBe(false);
  });
  it("force-on (repoFlag true) beats the master flag AND the BYO suppressor", () => {
    const d = nativeReviewerDecision({ masterFlag: false, repoFlag: true, isDraft: false, hasByoReviewer: true, dailyCapReached: false });
    expect(d.dispatch).toBe(true);
    expect(d.reason).toBe("forced");
  });
  it("BYO review agent suppresses the default dispatch", () => {
    expect(nativeReviewerDecision({ ...on, hasByoReviewer: true }).dispatch).toBe(false);
  });
  it("master-off blocks the default dispatch", () => {
    expect(nativeReviewerDecision({ ...on, masterFlag: false }).dispatch).toBe(false);
  });
  it("the daily cap blocks even a forced dispatch", () => {
    expect(nativeReviewerDecision({ ...on, repoFlag: true, dailyCapReached: true }).dispatch).toBe(false);
  });
});

describe("validateNativeReviewContract", () => {
  it("accepts a well-formed native-review-v1 payload", () => {
    const r = validateNativeReviewContract({
      verdict: "comment",
      summary: "The diff matches the stated intent; adds a retry with backoff.",
      additionalFocus: [{ path: "src/x.ts", startLine: 10, endLine: 20, reason: "unbounded retry loop" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contract.version).toBe("native-review-v1");
      expect(r.contract.additionalFocus[0].reason).toBe("unbounded retry loop");
    }
  });
  it("rejects a missing summary", () => {
    const r = validateNativeReviewContract({ verdict: "approve" });
    expect(r.ok).toBe(false);
  });
  it("rejects an over-long summary (never truncates)", () => {
    const r = validateNativeReviewContract({ verdict: "comment", summary: "x".repeat(2001) });
    expect(r.ok).toBe(false);
  });
  it("rejects more than 5 additionalFocus items", () => {
    const focus = Array.from({ length: 6 }, (_, i) => ({ path: "a.ts", startLine: i, endLine: i, reason: "r" }));
    const r = validateNativeReviewContract({ verdict: "comment", summary: "ok", additionalFocus: focus });
    expect(r.ok).toBe(false);
  });
  it("accepts note as an alias for reason", () => {
    const r = validateNativeReviewContract({
      verdict: "comment", summary: "ok",
      additionalFocus: [{ path: "a.ts", startLine: 1, endLine: 1, note: "from note" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contract.additionalFocus[0].reason).toBe("from note");
  });
});
