import { describe, it, expect } from "vitest";
import { shouldEnqueueTriggered, MAX_TRIGGER_DEPTH, withinTriggerRateCap, TRIGGER_RATE_CAP, withinRepoTriggerRateCap, REPO_TRIGGER_RATE_CAP, type LiveRun } from "../src/services/ci-trigger.js";
import { isCiOriginatedEvent, handleEventForPipelines } from "../src/services/event-pipeline-trigger.js";
import { runSchedulerTick } from "../src/services/pipeline-scheduler.js";
import type { DB } from "../src/models/db.js";
import type { EventBus, ClawHubEvent } from "../src/services/events.js";
import { ciPipelines, ciRuns, repositories, agents, organizations, branches } from "../src/models/schema.js";

// ---------------------------------------------------------------------------
// (b)+(c) Pure loop guard — no DB needed.
// ---------------------------------------------------------------------------
describe("shouldEnqueueTriggered (loop guard)", () => {
  it("allows a fresh event run at depth 1 with no live runs", () => {
    expect(shouldEnqueueTriggered({ origin: "event", triggerDepth: 1, triggerEvent: "change.merged" }, [])).toBe(true);
  });

  it("refuses depth greater than the ceiling (depth > 1)", () => {
    expect(MAX_TRIGGER_DEPTH).toBe(1);
    expect(shouldEnqueueTriggered({ origin: "event", triggerDepth: 2, triggerEvent: "change.merged" }, [])).toBe(false);
  });

  // The depth cap + per-commit de-dup don't bound a cascade whose every hop is a
  // NEW commit; the rate cap does. Once a pipeline hits the ceiling in-window,
  // further triggers are refused regardless of commit/event novelty.
  it("rate cap bounds a commit-churning cascade", () => {
    expect(withinTriggerRateCap(TRIGGER_RATE_CAP - 1)).toBe(true);  // last allowed
    expect(withinTriggerRateCap(TRIGGER_RATE_CAP)).toBe(false);     // ceiling reached
    expect(withinTriggerRateCap(TRIGGER_RATE_CAP + 50)).toBe(false); // runaway loop refused
  });

  it("repo-level cap bounds cross-pipeline multiplication", () => {
    expect(withinRepoTriggerRateCap(REPO_TRIGGER_RATE_CAP - 1)).toBe(true);
    expect(withinRepoTriggerRateCap(REPO_TRIGGER_RATE_CAP)).toBe(false);
  });

  it("de-dups an identical (pipeline, commit, triggerEvent) live run", () => {
    const live: LiveRun[] = [{ triggerEvent: "change.merged" }];
    expect(shouldEnqueueTriggered({ origin: "event", triggerDepth: 1, triggerEvent: "change.merged" }, live)).toBe(false);
    // A different event type on the same commit is not a dup.
    expect(shouldEnqueueTriggered({ origin: "event", triggerDepth: 1, triggerEvent: "issue.opened" }, live)).toBe(true);
  });

  it("treats scheduled runs (no triggerEvent) as de-dup keyed on null", () => {
    const live: LiveRun[] = [{ triggerEvent: null }];
    expect(shouldEnqueueTriggered({ origin: "schedule", triggerDepth: 0 }, live)).toBe(false);
    expect(shouldEnqueueTriggered({ origin: "schedule", triggerDepth: 0 }, [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (a) ci.* events never drive event-pipelines.
// ---------------------------------------------------------------------------
describe("isCiOriginatedEvent (loop guard (a))", () => {
  it("flags ci.* events", () => {
    expect(isCiOriginatedEvent("ci.run.queued")).toBe(true);
    expect(isCiOriginatedEvent("ci.running")).toBe(true);
    expect(isCiOriginatedEvent("ci.completed")).toBe(true);
  });
  it("does not flag non-ci events", () => {
    expect(isCiOriginatedEvent("change.merged")).toBe(false);
    expect(isCiOriginatedEvent("issue.opened")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Minimal in-memory fake of the Drizzle chains the modules call. It records
// inserted ci_runs and published events so tests can assert enqueue behavior.
// ---------------------------------------------------------------------------
interface Pipeline {
  id: string; repoId: string; name: string; yaml: string; enabled: boolean;
  triggerKind: string; triggerConfig: Record<string, unknown>; lastScheduledRunAt: Date | null;
}
interface Run { id: string; pipelineId: string; repoId: string; commit: string | null; triggerEvent: string | null; status: string; origin: string | null; triggerDepth: number; }

class FakeWorld {
  pipelines: Pipeline[] = [];
  runs: Run[] = [];
  repositories = [{ id: "repo1", name: "demo", namespaceType: "agent", namespaceId: "ag1", defaultBranch: "main" }];
  agents = [{ id: "ag1", name: "alice" }];
  branches = [{ repoId: "repo1", name: "main", headCommit: "deadbeef" }];
  published: ClawHubEvent[] = [];
  private runSeq = 0;

  events: EventBus = { publish: async (e: ClawHubEvent) => { this.published.push(e); } } as unknown as EventBus;

  // The fake recognizes which table a chain targets by identity of the table
  // object passed to .from()/.update()/.insert(), so it stays faithful to the
  // real schema imports.
  db = makeFakeDb(this);

  nextRunId() { return `run${++this.runSeq}`; }
}

function makeFakeDb(w: FakeWorld): DB {
  // Compare against the actual schema table objects (imported above) so the fake
  // routes each Drizzle chain to the right in-memory array.
  const tableFor = (t: unknown): keyof FakeWorld | null => {
    if (t === ciPipelines) return "pipelines";
    if (t === ciRuns) return "runs";
    if (t === repositories) return "repositories";
    if (t === agents) return "agents";
    if (t === organizations) return null;
    if (t === branches) return "branches";
    return null;
  };

  const select = (_cols?: unknown) => ({
    from(table: unknown) {
      const key = tableFor(table);
      let rows: unknown[] = key ? (w[key] as unknown[]).slice() : [];
      const chain = {
        where(_cond: unknown) {
          // The fake cannot evaluate Drizzle SQL conditions, so callers must
          // supply rows already shaped for the single repo/pipeline under test.
          // We honor the few filters the tests rely on via post-filters below.
          return chain;
        },
        limit(_n: number) { return Promise.resolve(rows.slice(0, _n)); },
        then(res: (v: unknown[]) => void) { res(rows); },
      };
      // Make the chain awaitable (acts as a Promise resolving to rows).
      return chain as typeof chain & PromiseLike<unknown[]>;
    },
  });

  const db = {
    select,
    insert(table: unknown) {
      const key = tableFor(table);
      return {
        values(vals: Record<string, unknown>) {
          return {
            returning() {
              if (key === "runs") {
                const run: Run = {
                  id: w.nextRunId(),
                  pipelineId: String(vals.pipelineId),
                  repoId: String(vals.repoId),
                  commit: (vals.commit as string) ?? null,
                  triggerEvent: (vals.triggerEvent as string) ?? null,
                  status: "pending",
                  origin: (vals.origin as string) ?? null,
                  triggerDepth: Number(vals.triggerDepth ?? 0),
                };
                w.runs.push(run);
                return Promise.resolve([run]);
              }
              return Promise.resolve([{ id: "x", ...vals }]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      const key = tableFor(table);
      return {
        set(vals: Record<string, unknown>) {
          return {
            where(_cond: unknown) {
              return {
                returning(_cols?: unknown) {
                  // CAS claim on ci_pipelines.lastScheduledRunAt: the scheduler
                  // reads then claims. The fake applies the set and reports one
                  // claimed row, modeling the winning loop.
                  if (key === "pipelines") {
                    for (const p of w.pipelines) p.lastScheduledRunAt = vals.lastScheduledRunAt as Date;
                    return Promise.resolve(w.pipelines.map(p => ({ id: p.id })));
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };
  return db as unknown as DB;
}

// The select fake returns whole tables; the modules then JS-filter pipelines by
// triggerKind/triggerConfig and look up runs/branches. We keep each test's world
// scoped to a single repo + pipeline so unfiltered table reads are still correct.

// ---------------------------------------------------------------------------
// Scheduler: cronDue gating + double-fire CAS claim.
// ---------------------------------------------------------------------------
describe("runSchedulerTick", () => {
  it("enqueues a run at default-branch HEAD when a cron tick is due", async () => {
    const w = new FakeWorld();
    w.pipelines = [{ id: "p1", repoId: "repo1", name: "nightly", yaml: "on: schedule\ncron: \"*/5 * * * *\"\nsteps: []", enabled: true, triggerKind: "schedule", triggerConfig: { cron: "*/5 * * * *" }, lastScheduledRunAt: new Date(Date.UTC(2026, 5, 12, 12, 1)) }];
    const now = new Date(Date.UTC(2026, 5, 12, 12, 5)); // 12:05 is a 5-tick
    const n = await runSchedulerTick(w.db, w.events, now);
    expect(n).toBe(1);
    expect(w.runs.length).toBe(1);
    expect(w.runs[0].commit).toBe("deadbeef");
    expect(w.runs[0].origin).toBe("schedule");
    expect(w.runs[0].triggerDepth).toBe(0);
    // ci.run.queued published with the push-path payload shape.
    const ev = w.published.find(e => e.type === "ci.run.queued");
    expect(ev).toBeTruthy();
    expect((ev!.payload as Record<string, unknown>).commit).toBe("deadbeef");
    expect((ev!.payload as Record<string, unknown>).runnerToken).toBeTruthy();
    expect((ev!.payload as Record<string, unknown>).repoNs).toBe("alice");
  });

  it("does not enqueue when no cron tick falls in (last, now]", async () => {
    const w = new FakeWorld();
    w.pipelines = [{ id: "p1", repoId: "repo1", name: "nightly", yaml: "x", enabled: true, triggerKind: "schedule", triggerConfig: { cron: "*/5 * * * *" }, lastScheduledRunAt: new Date(Date.UTC(2026, 5, 12, 12, 6)) }];
    const now = new Date(Date.UTC(2026, 5, 12, 12, 9)); // 12:07,08,09 — no 5-tick
    const n = await runSchedulerTick(w.db, w.events, now);
    expect(n).toBe(0);
    expect(w.runs.length).toBe(0);
  });

  it("advances lastScheduledRunAt so an immediate re-tick does not double-fire", async () => {
    const w = new FakeWorld();
    w.pipelines = [{ id: "p1", repoId: "repo1", name: "nightly", yaml: "x", enabled: true, triggerKind: "schedule", triggerConfig: { cron: "*/5 * * * *" }, lastScheduledRunAt: new Date(Date.UTC(2026, 5, 12, 12, 1)) }];
    const now = new Date(Date.UTC(2026, 5, 12, 12, 5));
    expect(await runSchedulerTick(w.db, w.events, now)).toBe(1);
    // lastScheduledRunAt is now 12:05. Re-running at the same minute: not due.
    expect(await runSchedulerTick(w.db, w.events, now)).toBe(0);
    expect(w.runs.length).toBe(1);
  });

  it("skips schedule pipelines with no cron", async () => {
    const w = new FakeWorld();
    w.pipelines = [{ id: "p1", repoId: "repo1", name: "x", yaml: "x", enabled: true, triggerKind: "schedule", triggerConfig: {}, lastScheduledRunAt: null }];
    expect(await runSchedulerTick(w.db, w.events, new Date())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Event fan-out: repo+type matching, guard (a), depth=1, de-dup.
// ---------------------------------------------------------------------------
function eventPipeline(): Pipeline {
  return { id: "p1", repoId: "repo1", name: "on-merge", yaml: "on: event\nevent: change.merged\nsteps: []", enabled: true, triggerKind: "event", triggerConfig: { event: "change.merged" }, lastScheduledRunAt: null };
}

describe("handleEventForPipelines", () => {
  it("enqueues a depth-1 run for a matching event type + repo", async () => {
    const w = new FakeWorld();
    w.pipelines = [eventPipeline()];
    const n = await handleEventForPipelines(w.db, w.events, { type: "change.merged", repoId: "repo1" });
    expect(n).toBe(1);
    expect(w.runs[0].origin).toBe("event");
    expect(w.runs[0].triggerEvent).toBe("change.merged");
    expect(w.runs[0].triggerDepth).toBe(1);
    expect(w.runs[0].commit).toBe("deadbeef");
  });

  it("ignores events whose type does not match the pipeline config", async () => {
    const w = new FakeWorld();
    w.pipelines = [eventPipeline()];
    expect(await handleEventForPipelines(w.db, w.events, { type: "issue.opened", repoId: "repo1" })).toBe(0);
    expect(w.runs.length).toBe(0);
  });

  it("never fans out for ci.* events (guard (a)) even if a pipeline matched", async () => {
    const w = new FakeWorld();
    // A (mis)configured event pipeline listening for ci.completed must NOT fire —
    // that is exactly the cycle guard (a) closes.
    w.pipelines = [{ ...eventPipeline(), triggerConfig: { event: "ci.completed" } }];
    expect(await handleEventForPipelines(w.db, w.events, { type: "ci.completed", repoId: "repo1" })).toBe(0);
    expect(w.runs.length).toBe(0);
  });

  it("ignores events with no repoId", async () => {
    const w = new FakeWorld();
    w.pipelines = [eventPipeline()];
    expect(await handleEventForPipelines(w.db, w.events, { type: "change.merged" })).toBe(0);
  });

  it("de-dups a burst of the same event on the same commit to one run", async () => {
    const w = new FakeWorld();
    w.pipelines = [eventPipeline()];
    await handleEventForPipelines(w.db, w.events, { type: "change.merged", repoId: "repo1" });
    // Second identical event while the first run is still pending: no new run.
    const second = await handleEventForPipelines(w.db, w.events, { type: "change.merged", repoId: "repo1" });
    expect(second).toBe(0);
    expect(w.runs.length).toBe(1);
  });
});
