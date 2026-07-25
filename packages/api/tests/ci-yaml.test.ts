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

  it("parses runs_on into an event pipeline's config (arch-targeted dispatch)", () => {
    const t = parsePipelineTrigger("on: event\nevent: change.merged\nruns_on: amd64\nsteps:\n  - run: sh build.sh\n");
    expect(t).toEqual({ kind: "event", config: { event: "change.merged", runsOn: "amd64" } });
  });

  it("parses runs_on into a schedule pipeline's config too", () => {
    const t = parsePipelineTrigger("on: schedule\ncron: \"0 3 * * *\"\nruns_on: arm64\nsteps:\n  - run: sh nightly.sh\n");
    expect(t.kind).toBe("schedule");
    expect(t.config).toEqual({ cron: "0 3 * * *", runsOn: "arm64" });
  });

  it("omits runsOn when runs_on is absent (fail-safe: any runner may claim)", () => {
    const t = parsePipelineTrigger("on: event\nevent: change.merged\nsteps:\n  - run: sh x.sh\n");
    expect(t.config.runsOn).toBeUndefined();
  });

  // `timeout_sec:` — the runner always honoured payload.timeoutSec but nothing could
  // SET it for a CI run, so every run took the 1800s default and a long build (the
  // agent-harness image: Playwright + Chromium + ~8 CLIs) was SIGKILLed mid-Dockerfile.
  it("parses timeout_sec into config (the per-pipeline wall-clock budget)", () => {
    expect(parsePipelineTrigger("on: event\nevent: change.merged\ntimeout_sec: 5400\nsteps:\n  - run: sh b.sh\n").config.timeoutSec).toBe(5400);
  });

  it("omits timeoutSec when absent (the runner keeps its 1800s default)", () => {
    expect(parsePipelineTrigger("on: push\nsteps:\n  - run: npm test\n").config.timeoutSec).toBeUndefined();
  });

  it("bounds a bogus timeout_sec so a typo can't disable the cap or wedge a runner", () => {
    // Non-numeric / non-positive → absent (fall back to the runner default).
    expect(parsePipelineTrigger("on: push\ntimeout_sec: soon\nsteps: []\n").config.timeoutSec).toBeUndefined();
    expect(parsePipelineTrigger("on: push\ntimeout_sec: 0\nsteps: []\n").config.timeoutSec).toBeUndefined();
    expect(parsePipelineTrigger("on: push\ntimeout_sec: -5\nsteps: []\n").config.timeoutSec).toBeUndefined();
    // Clamped into [60, 21600].
    expect(parsePipelineTrigger("on: push\ntimeout_sec: 5\nsteps: []\n").config.timeoutSec).toBe(60);
    expect(parsePipelineTrigger("on: push\ntimeout_sec: 999999\nsteps: []\n").config.timeoutSec).toBe(21_600);
  });

  it("parses execution:host/deploy into config (a REQUEST — inert until the server allowlists the repo)", () => {
    expect(parsePipelineTrigger("on: merge\nexecution: host\nsteps:\n  - run: ./deploy.sh\n").config.execution).toBe("host");
    expect(parsePipelineTrigger("on: merge\nexecution: deploy\nsteps: []\n").config.execution).toBe("deploy");
    expect(parsePipelineTrigger("on: event\nevent: change.merged\nexecution: build\nsteps:\n  - run: buildctl ...\n").config.execution).toBe("build");
    expect(parsePipelineTrigger("on: event\nevent: change.merged\nexecution: host\nruns_on: amd64\nsteps:\n  - run: sh b.sh\n").config).toEqual({ event: "change.merged", runsOn: "amd64", execution: "host" });
  });

  it("everything except a literal execution:host is contained (fail-safe: no execution key ⇒ sandbox)", () => {
    expect(parsePipelineTrigger("on: push\nsteps:\n  - run: npm test\n").config.execution).toBeUndefined();
    expect(parsePipelineTrigger("on: merge\nexecution: sandbox\nsteps:\n  - run: x\n").config.execution).toBeUndefined();
    expect(parsePipelineTrigger("on: merge\nexecution: HOST\nsteps:\n  - run: x\n").config.execution).toBeUndefined(); // case-strict
    expect(parsePipelineTrigger("on: merge\nexecution: yes-please\nsteps:\n  - run: x\n").config.execution).toBeUndefined();
  });

  it("legacy pipelineTrigger maps schedule/event to push, merge to merge", () => {
    expect(pipelineTrigger("on: merge\nsteps: []\n")).toBe("merge");
    expect(pipelineTrigger("on: schedule\ncron: \"* * * * *\"\nsteps: []\n")).toBe("push");
    expect(pipelineTrigger("on: event\nevent: change.opened\nsteps: []\n")).toBe("push");
    expect(pipelineTrigger("steps: []\n")).toBe("push");
  });
});
