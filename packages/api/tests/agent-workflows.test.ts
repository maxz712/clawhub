import { describe, expect, it } from "vitest";
import { SLASH_WORKFLOWS, expandWorkflowTask } from "../src/services/agent-workflows.js";

describe("expandWorkflowTask", () => {
  it("expands a slash flag into the preset and pins its mode", () => {
    const r = expandWorkflowTask("/review");
    expect(r.mode).toBe("review");
    expect(r.task).toBe(SLASH_WORKFLOWS["/review"].instructions);
  });

  it("appends trailing text as operator focus", () => {
    const r = expandWorkflowTask("/dev focus on dark mode");
    expect(r.mode).toBe("develop");
    expect(r.task).toContain(SLASH_WORKFLOWS["/dev"].instructions);
    expect(r.task).toContain("Operator focus for this run: focus on dark mode");
  });

  it("passes plain prose through untouched with no mode pin", () => {
    const r = expandWorkflowTask("keep deps current and tests green");
    expect(r.task).toBe("keep deps current and tests green");
    expect(r.mode).toBeUndefined();
  });

  it("passes unknown flags through untouched (not every / is a workflow)", () => {
    const r = expandWorkflowTask("/unknown-flag do stuff");
    expect(r.task).toBe("/unknown-flag do stuff");
    expect(r.mode).toBeUndefined();
  });

  it("handles null/empty", () => {
    expect(expandWorkflowTask(null).task).toBe("");
    expect(expandWorkflowTask("").mode).toBeUndefined();
  });

  it("every workflow pins a valid harness mode", () => {
    for (const wf of Object.values(SLASH_WORKFLOWS)) {
      expect(["develop", "worker", "verify", "review", "triage", "reflect"]).toContain(wf.mode);
      expect(wf.instructions.length).toBeGreaterThan(40);
    }
  });
});
