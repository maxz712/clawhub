import { describe, it, expect } from "vitest";
import { ciStatusFromHeadRuns } from "../src/services/ci-runner.js";

// Fixtures are the runs already SCOPED to the change's current head (the DB query
// does the head-scoping); this exercises the newest-per-pipeline + tie-break vote.
const t0 = new Date("2026-07-04T00:00:00Z");
const at = (s: number) => new Date(t0.getTime() + s * 1000);
type R = { pipelineId: string | null; status: string; finishedAt: Date | null; createdAt: Date };
const run = (pipelineId: string | null, status: string, created: number, finished?: number): R =>
  ({ pipelineId, status, createdAt: at(created), finishedAt: finished == null ? null : at(finished) });

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
