import { describe, it, expect } from "vitest";
import { parseYamlSubset, parsePipelineTrigger, pipelineTrigger } from "../src/services/ci-yaml.js";

describe("parseYamlSubset", () => {
  it("parses steps array", () => {
    const doc = parseYamlSubset(`name: build
steps:
  - name: install
    run: npm ci
  - run: npm test
`);
    expect(doc.name).toBe("build");
    const steps = doc.steps as Array<{ name?: string; run: string }>;
    expect(steps.length).toBe(2);
    expect(steps[0].run).toBe("npm ci");
    expect(steps[1].run).toBe("npm test");
  });

  it("parses scalar extends", () => {
    const doc = parseYamlSubset(`extends: ./base.yml
steps:
  - run: echo hi
`);
    expect(doc.extends).toBe("./base.yml");
  });
});

describe("parsePipelineTrigger", () => {
  it("defaults to push when on: is absent", () => {
    expect(parsePipelineTrigger("steps:\n  - run: npm test\n")).toEqual({ kind: "push", config: {} });
  });

  it("parses on: merge", () => {
    expect(parsePipelineTrigger("on: merge\nsteps:\n  - run: ./deploy.sh\n")).toEqual({ kind: "merge", config: {} });
  });

  it("parses on: schedule with cron", () => {
    const t = parsePipelineTrigger("on: schedule\ncron: \"*/5 * * * *\"\nsteps:\n  - run: ./audit.sh\n");
    expect(t.kind).toBe("schedule");
    expect(t.config.cron).toBe("*/5 * * * *");
  });

  it("schedule without cron leaves config empty (inert, not a push gate)", () => {
    const t = parsePipelineTrigger("on: schedule\nsteps:\n  - run: ./audit.sh\n");
    expect(t.kind).toBe("schedule");
    expect(t.config.cron).toBeUndefined();
  });

  it("parses on: event with event type", () => {
    const t = parsePipelineTrigger("on: event\nevent: change.merged\nsteps:\n  - run: ./notify.sh\n");
    expect(t).toEqual({ kind: "event", config: { event: "change.merged" } });
  });

  it("legacy pipelineTrigger maps schedule/event to push, merge to merge", () => {
    expect(pipelineTrigger("on: merge\nsteps: []\n")).toBe("merge");
    expect(pipelineTrigger("on: schedule\ncron: \"* * * * *\"\nsteps: []\n")).toBe("push");
    expect(pipelineTrigger("on: event\nevent: change.opened\nsteps: []\n")).toBe("push");
    expect(pipelineTrigger("steps: []\n")).toBe("push");
  });
});
