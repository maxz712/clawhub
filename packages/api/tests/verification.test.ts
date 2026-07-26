import { describe, it, expect } from "vitest";
import { normalizeChecks, verificationStatus, recordVerification, loadVerifiedAttestation, verificationTrust } from "../src/services/verification.js";
import { ciRuns, standingAgents, changes, verificationRuns } from "../src/models/schema.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../src/services/errors.js";
import type { DB } from "../src/models/db.js";

// Table-aware fake DB (same canned-row approach as change-intent.test.ts): each
// select(...).from(<table>) resolves the rows we staged for THAT table, so we can
// drive recordVerification's guard ladder without a Postgres. insert(...)
// .onConflictDoUpdate(...).returning() echoes the values back.
function fakeDb(tables: {
  ciRuns?: Record<string, unknown>[];
  standingAgents?: Record<string, unknown>[];
  changes?: Record<string, unknown>[];
  verificationRuns?: Record<string, unknown>[];
}): DB {
  const rowsFor = (t: unknown): Record<string, unknown>[] => {
    if (t === ciRuns) return tables.ciRuns ?? [];
    if (t === standingAgents) return tables.standingAgents ?? [];
    if (t === changes) return tables.changes ?? [];
    if (t === verificationRuns) return tables.verificationRuns ?? [];
    return [];
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: (_n: number) => Promise.resolve(rowsFor(t)),
        };
        return chain;
      },
    }),
    insert: (_t: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: (_o: unknown) => ({
          returning: () => Promise.resolve([{ id: "vr1", ...vals }]),
        }),
      }),
    }),
  };
  return db as unknown as DB;
}

describe("normalizeChecks", () => {
  it("validates kind + name and coerces ok to a strict boolean", () => {
    const out = normalizeChecks([{ kind: "api", name: "GET /health", ok: true }, { kind: "ui", name: "click save", ok: "yes" }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "api", name: "GET /health", ok: true });
    expect(out[1].ok).toBe(false); // only a literal `true` is a pass
  });
  it("rejects a non-array, a bad kind, and a missing name", () => {
    expect(() => normalizeChecks("nope")).toThrow(ValidationError);
    expect(() => normalizeChecks([{ kind: "telepathy", name: "x", ok: true }])).toThrow(ValidationError);
    expect(() => normalizeChecks([{ kind: "api", name: "", ok: true }])).toThrow(ValidationError);
  });
});

describe("verificationStatus", () => {
  it("succeeds only when every check passed and at least one ran", () => {
    expect(verificationStatus([{ kind: "api", name: "a", ok: true }])).toMatchObject({ status: "success", passed: 1, failed: 0 });
    expect(verificationStatus([{ kind: "api", name: "a", ok: true }, { kind: "ui", name: "b", ok: false }])).toMatchObject({ status: "failure", passed: 1, failed: 1 });
    expect(verificationStatus([])).toMatchObject({ status: "failure", passed: 0, failed: 0 }); // nothing ran → not a pass
  });
});

describe("recordVerification — server-side trust binding", () => {
  const ok = {
    repoId: "repo1", changeId: "chg1", callerAgentId: "agentV", runId: "run1",
    checks: [{ kind: "api" as const, name: "GET /health → 200", ok: true }],
  };
  const goodTables = () => ({
    ciRuns: [{ id: "run1", origin: "agent", standingAgentId: "sa1", repoId: "repo1", commit: "abc123" }],
    standingAgents: [{ id: "sa1", agentId: "agentV", mode: "verify" }],
    changes: [{ id: "chg1", repoId: "repo1", headCommit: "abc123", openedByAgentId: "agentA" }],
  });

  it("records a success attestation when every binding checks out", async () => {
    const res = await recordVerification(fakeDb(goodTables()), ok);
    expect(res).toMatchObject({ status: "success", passed: 1, failed: 0, headCommit: "abc123" });
  });

  it("404s when the run does not exist", async () => {
    await expect(recordVerification(fakeDb({ ciRuns: [] }), ok)).rejects.toThrow(NotFoundError);
  });

  it("rejects a run that is not a ClawHub-minted standing-agent run", async () => {
    const t = goodTables(); t.ciRuns = [{ id: "run1", origin: "push", standingAgentId: null, repoId: "repo1", commit: "abc123" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "not_agent_run" });
  });

  it("rejects a run from a different repo", async () => {
    const t = goodTables(); t.ciRuns = [{ id: "run1", origin: "agent", standingAgentId: "sa1", repoId: "OTHER", commit: "abc123" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "run_repo_mismatch" });
  });

  it("rejects when the caller is not the run's standing agent", async () => {
    const t = goodTables(); t.standingAgents = [{ id: "sa1", agentId: "SOMEONE_ELSE", mode: "verify" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "agent_mismatch" });
  });

  it("rejects when the standing agent is not in verify mode", async () => {
    const t = goodTables(); t.standingAgents = [{ id: "sa1", agentId: "agentV", mode: "review" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "not_verify_mode" });
  });

  it("rejects when the run commit does not match the change head (stale)", async () => {
    const t = goodTables(); t.changes = [{ id: "chg1", repoId: "repo1", headCommit: "DIFFERENT", openedByAgentId: "agentA" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "commit_mismatch" });
  });

  it("rejects self-verify (verifier IS the change author)", async () => {
    const t = goodTables(); t.changes = [{ id: "chg1", repoId: "repo1", headCommit: "abc123", openedByAgentId: "agentV" }];
    await expect(recordVerification(fakeDb(t), ok)).rejects.toMatchObject({ code: "self_verify_forbidden" });
  });

  it("computes failure when any check failed (a client cannot assert success)", async () => {
    const res = await recordVerification(fakeDb(goodTables()), { ...ok, checks: [{ kind: "ui", name: "x", ok: false }] });
    expect(res.status).toBe("failure");
  });
});

describe("loadVerifiedAttestation", () => {
  it("returns the attestation for a success row", async () => {
    const db = fakeDb({ verificationRuns: [{ agentId: "agentV", headCommit: "abc123" }] });
    expect(await loadVerifiedAttestation(db, "chg1", "abc123", "agentA")).toMatchObject({ ok: true, agentId: "agentV", headCommit: "abc123" });
  });
  it("returns undefined when there is no matching success row", async () => {
    expect(await loadVerifiedAttestation(fakeDb({ verificationRuns: [] }), "chg1", "abc123", "agentA")).toBeUndefined();
  });
  it("defense-in-depth: ignores an attestation by the change's own author", async () => {
    const db = fakeDb({ verificationRuns: [{ agentId: "agentA", headCommit: "abc123" }] });
    expect(await loadVerifiedAttestation(db, "chg1", "abc123", "agentA")).toBeUndefined();
  });
});

// The dashboard-facing trust flag (#78): a success attestation only "counts"
// while its verifying agent is still enabled + is not the change's author —
// exactly the merge gate's (loadVerifiedAttestation) preconditions. Once the
// agent is disabled (kill switch / circuit-breaker auto-pause) the gate silently
// drops it; this flag lets the UI stop rendering it as attested.
describe("verificationTrust", () => {
  it("counts a success row from an enabled, non-author verifier", () => {
    expect(verificationTrust({ status: "success", agentId: "agentV" }, true, "agentA"))
      .toEqual({ counts: true, staleReason: null });
  });
  it("stops counting once the verifying agent is disabled — the gate already dropped it", () => {
    expect(verificationTrust({ status: "success", agentId: "agentV" }, false, "agentA"))
      .toEqual({ counts: false, staleReason: "verifier_disabled" });
  });
  it("treats a deleted verifier (null enabled, SET NULL standingAgentId) as disabled", () => {
    expect(verificationTrust({ status: "success", agentId: "agentV" }, null, "agentA"))
      .toEqual({ counts: false, staleReason: "verifier_disabled" });
    expect(verificationTrust({ status: "success", agentId: "agentV" }, undefined, "agentA"))
      .toEqual({ counts: false, staleReason: "verifier_disabled" });
  });
  it("flags a self-verify (verifier IS the author) distinctly, even when enabled", () => {
    expect(verificationTrust({ status: "success", agentId: "agentA" }, true, "agentA"))
      .toEqual({ counts: false, staleReason: "self_verify" });
  });
  it("never marks a non-success row as a dropped attestation (failure/pending shown as-is)", () => {
    expect(verificationTrust({ status: "failure", agentId: "agentV" }, false, "agentA"))
      .toEqual({ counts: false, staleReason: null });
    expect(verificationTrust({ status: "pending", agentId: "agentV" }, true, "agentA"))
      .toEqual({ counts: false, staleReason: null });
  });
});
