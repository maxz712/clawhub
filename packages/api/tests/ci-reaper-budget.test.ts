import { describe, it, expect } from "vitest";
import { withinDeclaredBudget } from "../src/services/ci-runner.js";

// Regression coverage for the LAST of the harness-rebuild breaks: the stale-run
// sweep applied a hardcoded 15-MINUTE CI cutoff to every non-standing run, with no
// way for a legitimately long pipeline to say otherwise. The agent-harness image
// build (Playwright + Chromium + ~8 coding CLIs, ~40 min) was therefore marked
// "stuck" at ~940s on BOTH arch legs, every time — the log simply stopped mid-step
// with no error, because nothing had failed: the server gave up on a run that was
// still working. That is what made harness rebuilds look chronically flaky.
// `timeout_sec:` now flows YAML -> triggerConfig -> here.
describe("withinDeclaredBudget", () => {
  const now = new Date("2026-07-25T12:00:00Z");
  const startedMinAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  it("exempts a long build still inside its declared budget (the harness case)", () => {
    // 20 min into a 90-min (5400s) budget — the old 15-min cutoff would have killed it.
    expect(withinDeclaredBudget(startedMinAgo(20), 5400, now)).toBe(true);
  });

  it("stops exempting once the declared budget (plus grace) is spent", () => {
    // 95 min into a 90-min budget: past 5400s + 2min grace → the reaper may claim it.
    expect(withinDeclaredBudget(startedMinAgo(95), 5400, now)).toBe(false);
  });

  it("keeps the conservative default when a pipeline declares no budget", () => {
    for (const t of [undefined, null, 0, -1, Number.NaN]) {
      expect(withinDeclaredBudget(startedMinAgo(20), t as number, now)).toBe(false);
    }
  });

  it("never exempts a run with no start time (cannot reason about its age)", () => {
    expect(withinDeclaredBudget(null, 5400, now)).toBe(false);
    expect(withinDeclaredBudget(undefined, 5400, now)).toBe(false);
  });

  it("applies the grace window so the runner's own kill reports a real error first", () => {
    // Exactly at the budget: still exempt (inside grace) → the runner terminalizes it
    // with a genuine failure instead of the reaper's opaque "stuck".
    expect(withinDeclaredBudget(new Date(now.getTime() - 5400_000), 5400, now)).toBe(true);
    // Past budget + grace → no longer exempt.
    expect(withinDeclaredBudget(new Date(now.getTime() - 5400_000 - 121_000), 5400, now)).toBe(false);
  });
});
