import { describe, it, expect } from "vitest";
import { validateVerifyPlan, validateCheckMap, isLocalTarget, hashPaths, hashSpec, isPlanStale, recordPlaybackOutcome, type VerifyStep } from "../src/services/verify-plan.js";
import { ciRuns, standingAgents, changes, verifyPlans } from "../src/models/schema.js";
import { NotFoundError } from "../src/services/errors.js";
import type { DB } from "../src/models/db.js";

describe("isLocalTarget", () => {
  it("accepts relative paths and localhost URLs", () => {
    expect(isLocalTarget("/dashboard")).toBe(true);
    expect(isLocalTarget("http://localhost:3001/x")).toBe(true);
    expect(isLocalTarget("http://127.0.0.1:3000")).toBe(true);
  });
  it("rejects external hosts and protocol-relative URLs", () => {
    expect(isLocalTarget("https://evil.com/steal")).toBe(false);
    expect(isLocalTarget("//evil.com")).toBe(false);
    expect(isLocalTarget("file:///etc/passwd")).toBe(false);
    expect(isLocalTarget("")).toBe(false);
    expect(isLocalTarget(42)).toBe(false);
  });
});

describe("validateVerifyPlan", () => {
  it("accepts a whitelisted plan with local navigation", () => {
    const r = validateVerifyPlan([
      { type: "goto", url: "/login" },
      { type: "fill", selector: "#email", value: "x" },
      { type: "click", selector: "button" },
      { type: "snapshot" },
      { type: "expectVisible", selector: ".feed" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.steps).toHaveLength(5);
  });
  it("rejects an unknown step type", () => {
    const r = validateVerifyPlan([{ type: "exfiltrate", url: "/x" }]);
    expect(r.ok).toBe(false);
  });
  it("rejects a goto to an external host (attack guard)", () => {
    const r = validateVerifyPlan([{ type: "goto", url: "https://evil.com" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/relative path or localhost/);
  });
  it("rejects an apiCheck to an external host", () => {
    const r = validateVerifyPlan([{ type: "apiCheck", url: "https://evil.com/api" }]);
    expect(r.ok).toBe(false);
  });
  it("rejects an empty plan", () => {
    expect(validateVerifyPlan([]).ok).toBe(false);
  });
});

describe("isPlanStale", () => {
  const base = { changedPathsHash: "p", specHash: "s", tier: "app", failureCount: 0 };
  const cur = { changedPathsHash: "p", specHash: "s", tier: "app" };
  it("fresh when all anchors match and no failures", () => {
    expect(isPlanStale(base, cur)).toBe(false);
  });
  it("stale when the changed paths shift", () => {
    expect(isPlanStale(base, { ...cur, changedPathsHash: "other" })).toBe(true);
  });
  it("stale when the spec shifts", () => {
    expect(isPlanStale(base, { ...cur, specHash: "other" })).toBe(true);
  });
  it("stale when the tier changes", () => {
    expect(isPlanStale(base, { ...cur, tier: "dind" })).toBe(true);
  });
  it("stale after 2 consecutive playback failures", () => {
    expect(isPlanStale({ ...base, failureCount: 2 }, cur)).toBe(true);
  });
});

describe("validateCheckMap", () => {
  const steps: VerifyStep[] = [
    { type: "snapshot", selector: "body" },
    { type: "expectVisible", selector: "#ok" },
    { type: "apiCheck", url: "/api/v1/health" },
  ];
  it("accepts an empty/absent map", () => {
    expect(validateCheckMap(undefined, steps)).toEqual({ ok: true, checkMap: {} });
    expect(validateCheckMap(null, steps)).toEqual({ ok: true, checkMap: {} });
    expect(validateCheckMap({}, steps)).toEqual({ ok: true, checkMap: {} });
  });
  it("accepts ui mappings on assertion steps and api on apiCheck steps", () => {
    const r = validateCheckMap({ "1": { kind: "ui", name: "banner shows" }, "2": { kind: "api", name: "health 200" } }, steps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.checkMap["2"].kind).toBe("api");
  });
  it("REJECTS an api kind mapped onto a non-apiCheck step (the claim-upgrade attack)", () => {
    const r = validateCheckMap({ "0": { kind: "api", name: "endpoint returns 200" } }, steps);
    expect(r.ok).toBe(false);
  });
  it("rejects cli/script kinds — playback runs no commands", () => {
    expect(validateCheckMap({ "0": { kind: "cli", name: "tests pass" } }, steps).ok).toBe(false);
    expect(validateCheckMap({ "2": { kind: "script", name: "migration ran" } }, steps).ok).toBe(false);
  });
  it("rejects out-of-range or non-integer step keys", () => {
    expect(validateCheckMap({ "9": { kind: "ui" } }, steps).ok).toBe(false);
    expect(validateCheckMap({ "-1": { kind: "ui" } }, steps).ok).toBe(false);
    expect(validateCheckMap({ abc: { kind: "ui" } }, steps).ok).toBe(false);
  });
  it("defaults kind to ui, names the step, strips unknown fields, caps name length", () => {
    const r = validateCheckMap({ "1": { name: "x".repeat(500), transcript: "smuggled", ok: true } }, steps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.checkMap["1"]).toEqual({ kind: "ui", name: "x".repeat(200) });
      expect(Object.keys(r.checkMap["1"])).toEqual(["kind", "name"]);
    }
  });
  it("rejects arrays and non-object entries", () => {
    expect(validateCheckMap([{ kind: "ui" }], steps).ok).toBe(false);
    expect(validateCheckMap({ "0": "ui" }, steps).ok).toBe(false);
  });
});

// Table-aware fake DB (same approach as verification.test.ts): select(...).from(<table>)
// resolves the staged rows for that table; update(verifyPlans).set(patch).where(...)
// mutates the staged plan row in place so a later loadActiveVerifyPlan/isPlanStale
// in the SAME test observes the write — this is the only way failureCount ever
// moves, so the test needs to see it actually land.
function fakeDb(tables: {
  ciRuns?: Record<string, unknown>[];
  standingAgents?: Record<string, unknown>[];
  changes?: Record<string, unknown>[];
  verifyPlans?: Record<string, unknown>[];
}): DB {
  const rowsFor = (t: unknown): Record<string, unknown>[] => {
    if (t === ciRuns) return tables.ciRuns ?? [];
    if (t === standingAgents) return tables.standingAgents ?? [];
    if (t === changes) return tables.changes ?? [];
    if (t === verifyPlans) return tables.verifyPlans ?? [];
    return [];
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const chain = {
          where: () => chain,
          limit: (_n: number) => Promise.resolve(rowsFor(t)),
        };
        return chain;
      },
    }),
    update: (t: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          if (t === verifyPlans) for (const row of tables.verifyPlans ?? []) Object.assign(row, patch);
          return Promise.resolve();
        },
      }),
    }),
  };
  return db as unknown as DB;
}

describe("recordPlaybackOutcome — the write path failureCount was missing", () => {
  const input = { repoId: "repo1", changeId: "chg1", callerAgentId: "agentV", runId: "run1", success: false };
  const goodTables = () => ({
    ciRuns: [{ id: "run1", origin: "agent", standingAgentId: "sa1", repoId: "repo1", commit: "abc123" }],
    standingAgents: [{ id: "sa1", agentId: "agentV", mode: "verify" }],
    changes: [{ id: "chg1", repoId: "repo1", headCommit: "abc123" }],
    verifyPlans: [{ id: "plan1", repoId: "repo1", changeId: "chg1", active: true, failureCount: 0, changedPathsHash: "p", specHash: "s", tier: "app" }],
  });

  it("increments failureCount by 1 on a failed playback", async () => {
    const res = await recordPlaybackOutcome(fakeDb(goodTables()), input);
    expect(res).toEqual({ failureCount: 1 });
  });

  it("resets failureCount to 0 on a successful playback", async () => {
    const t = goodTables(); t.verifyPlans[0].failureCount = 1;
    const res = await recordPlaybackOutcome(fakeDb(t), { ...input, success: true });
    expect(res).toEqual({ failureCount: 0 });
  });

  it("two consecutive failures actually flip isPlanStale to true (the acceptance criterion)", async () => {
    const t = goodTables();
    const db = fakeDb(t);
    await recordPlaybackOutcome(db, input);
    expect(isPlanStale(t.verifyPlans[0] as any, { changedPathsHash: "p", specHash: "s", tier: "app" })).toBe(false); // 1 failure — not yet stale
    await recordPlaybackOutcome(db, input);
    expect(t.verifyPlans[0].failureCount).toBe(2);
    expect(isPlanStale(t.verifyPlans[0] as any, { changedPathsHash: "p", specHash: "s", tier: "app" })).toBe(true); // 2 — stale now
  });

  it("returns null (no-op) when the change has no active plan", async () => {
    const t = goodTables(); t.verifyPlans = [];
    expect(await recordPlaybackOutcome(fakeDb(t), input)).toBeNull();
  });

  it("404s when the run does not exist", async () => {
    await expect(recordPlaybackOutcome(fakeDb({ ciRuns: [] }), input)).rejects.toThrow(NotFoundError);
  });

  it("rejects a run that is not a ClawHub-minted standing-agent run", async () => {
    const t = goodTables(); t.ciRuns = [{ id: "run1", origin: "push", standingAgentId: null, repoId: "repo1", commit: "abc123" }];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toMatchObject({ code: "not_agent_run" });
  });

  it("rejects a run from a different repo", async () => {
    const t = goodTables(); t.ciRuns = [{ id: "run1", origin: "agent", standingAgentId: "sa1", repoId: "OTHER", commit: "abc123" }];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toMatchObject({ code: "run_repo_mismatch" });
  });

  it("rejects when the caller is not the run's standing agent", async () => {
    const t = goodTables(); t.standingAgents = [{ id: "sa1", agentId: "SOMEONE_ELSE", mode: "verify" }];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toMatchObject({ code: "agent_mismatch" });
  });

  it("rejects when the standing agent is not in verify mode", async () => {
    const t = goodTables(); t.standingAgents = [{ id: "sa1", agentId: "agentV", mode: "review" }];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toMatchObject({ code: "not_verify_mode" });
  });

  it("rejects when the run commit does not match the change head (stale)", async () => {
    const t = goodTables(); t.changes = [{ id: "chg1", repoId: "repo1", headCommit: "DIFFERENT" }];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toMatchObject({ code: "commit_mismatch" });
  });

  it("404s when the change does not exist", async () => {
    const t = goodTables(); t.changes = [];
    await expect(recordPlaybackOutcome(fakeDb(t), input)).rejects.toThrow(NotFoundError);
  });
});

describe("hashPaths / hashSpec", () => {
  it("is order-independent for paths and stable", () => {
    expect(hashPaths(["a", "b"])).toBe(hashPaths(["b", "a"]));
    expect(hashPaths(["a"])).not.toBe(hashPaths(["b"]));
  });
  it("hashSpec is stable and differs on content", () => {
    expect(hashSpec("x")).toBe(hashSpec("x"));
    expect(hashSpec("x")).not.toBe(hashSpec("y"));
  });
});
