import { describe, it, expect } from "vitest";
import { ciStatusFromHeadRuns } from "../src/services/ci-runner.js";

// Fixtures are the runs already SCOPED to the change's current head (the DB query
// does the head-scoping); this exercises the newest-per-pipeline + tie-break vote.
const t0 = new Date("2026-07-04T00:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
type R = { pipelineId: string | null; status: string; finishedAt: Date | null; createdAt: Date; terminalReason?: string | null };
const run = (pipelineId: string | null, status: string, created: number, finished?: number, terminalReason: string | null = null): R =>
  ({ pipelineId, status, createdAt: at(created), finishedAt: finished == null ? null : at(finished), terminalReason });
// run-staleness stamps a cancellation as status 'skipped' + a terminalReason.
const canceled = (pipelineId: string | null, reason: string, created: number, finished?: number): R =>
  run(pipelineId, "skipped", created, finished ?? created + 1, reason);

describe("ciStatusFromHeadRuns", () => {
  it("no pipeline-bearing runs → null (caller decides pending vs skipped)", () => {
    expect(ciStatusFromHeadRuns([])).toBeNull();
    // a standing (pipeline-less) run never votes
    expect(ciStatusFromHeadRuns([run(null, "failure", 1, 2)])).toBeNull();
  });

  it("single passing pipeline → success", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5)])).toBe("success");
  });

  it("a failure is decisive even alongside a passing pipeline", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p2", "failure", 1, 6)])).toBe("failure");
  });

  it("all pipelines pass (success or skipped) → success", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p2", "skipped", 1, 2)])).toBe("success");
  });

  it("a still-running pipeline blocks success (running), even if another passed", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p2", "running", 2)])).toBe("running");
  });

  it("a pending pipeline (dispatched, not started) blocks (pending)", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p2", "pending", 2)])).toBe("pending");
  });

  it("THE BUG: a later orphaned 'running' duplicate must NOT hide the pipeline's real success (terminal-first)", () => {
    // Same pipeline+head: a genuine success, plus a newer orphaned 'running' left
    // by a bounced runner. Terminal-first tie-break keeps the success.
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p1", "running", 9)])).toBe("success");
  });

  it("a later orphaned 'pending' duplicate must NOT hide the pipeline's real failure", () => {
    expect(ciStatusFromHeadRuns([run("p1", "failure", 1, 5), run("p1", "pending", 9)])).toBe("failure");
  });

  it("a genuine re-run that PASSED later overrides an earlier failure on the same pipeline+head", () => {
    // both terminal → newest finishedAt wins (a retry that went green)
    expect(ciStatusFromHeadRuns([run("p1", "failure", 1, 5), run("p1", "success", 6, 10)])).toBe("success");
  });

  it("a genuine re-run that FAILED later overrides an earlier success on the same pipeline+head", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p1", "failure", 6, 10)])).toBe("failure");
  });
});

// #203 — `skipped` carries two meanings and only the benign one may pass: a run
// CANCELLED in flight (terminalReason canceled/superseded/stale) owes a result.
// Before this, abandon→reopen laundered a cancellation into ciStatus 'success'
// under ciRequired+requireCiRun with zero CI steps ever executed.
describe("ciStatusFromHeadRuns — cancelled runs never vote success (#203)", () => {
  it("THE BUG: a cancelled run alone must NOT vote success (abandon→reopen replay)", () => {
    expect(ciStatusFromHeadRuns([canceled("p1", "canceled", 1)])).not.toBe("success");
    expect(ciStatusFromHeadRuns([canceled("p1", "canceled", 1)])).toBe("pending");
    expect(ciStatusFromHeadRuns([canceled("p1", "stale", 1)])).toBe("pending");
  });
  it("THE BUG: a cancelled TERMINAL run must not outrank a NEWER queued rerun (force-push replay)", () => {
    // Same pipeline+head: superseded cancellation + the fresh pending rerun. The
    // unconditional TERMINAL-FIRST tie-break used to pick the cancellation → success.
    expect(ciStatusFromHeadRuns([canceled("p1", "superseded", 1), run("p1", "pending", 9)])).toBe("pending");
  });
  it("a cancelled run alongside another pipeline's pass still blocks (owes a result)", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), canceled("p2", "canceled", 1)])).toBe("pending");
  });
  it("a real rerun result clears the cancellation (self-heals)", () => {
    expect(ciStatusFromHeadRuns([canceled("p1", "superseded", 1), run("p1", "success", 6, 10)])).toBe("success");
    expect(ciStatusFromHeadRuns([canceled("p1", "superseded", 1), run("p1", "failure", 6, 10)])).toBe("failure");
  });
  it("benign skipped (terminalReason null — nothing to run) keeps passing", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p2", "skipped", 1, 2)])).toBe("success");
  });
  it("a genuine success still beats a later orphaned running/pending duplicate", () => {
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p1", "running", 9)])).toBe("success");
    expect(ciStatusFromHeadRuns([run("p1", "success", 1, 5), run("p1", "pending", 9)])).toBe("success");
  });
  it("pipeline-less (standing) cancellations still never vote", () => {
    expect(ciStatusFromHeadRuns([canceled(null, "canceled", 1)])).toBeNull();
  });
});
