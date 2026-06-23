import { describe, it, expect } from "vitest";
import { ChangeService, MAX_INTENT_LEN, validateIntent } from "../src/services/changes.js";
import { ValidationError, NotFoundError, ConflictError } from "../src/services/errors.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";
import type { EventBus } from "../src/services/events.js";

// Feature: let a human EDIT a Change's description (`intent`). Today `intent` is
// frozen at push time from the commit `Intent:` trailer; this is the sole edit
// path. We unit-test the pure validation (validateIntent) and the service-layer
// update (ChangeService.updateIntent) against a canned-row fake DB — the same
// approach as namespace-resolution.test.ts / code-tree-route.test.ts — so the
// load-bearing behavior (validation + trim + persistence + 404) is covered
// without booting a server.

describe("validateIntent", () => {
  it("trims and accepts a non-empty intent", () => {
    expect(validateIntent("  refactor the parser  ")).toBe("refactor the parser");
  });

  it("rejects an empty / whitespace-only intent", () => {
    expect(() => validateIntent("")).toThrow(ValidationError);
    expect(() => validateIntent("   ")).toThrow(ValidationError);
  });

  it("rejects a non-string intent", () => {
    expect(() => validateIntent(undefined)).toThrow(ValidationError);
    expect(() => validateIntent(123 as unknown)).toThrow(ValidationError);
  });

  it("accepts exactly MAX_INTENT_LEN characters but rejects one more", () => {
    expect(validateIntent("a".repeat(MAX_INTENT_LEN))).toHaveLength(MAX_INTENT_LEN);
    expect(() => validateIntent("a".repeat(MAX_INTENT_LEN + 1))).toThrow(ValidationError);
  });

  it("counts length AFTER trimming (surrounding whitespace doesn't push over the cap)", () => {
    const padded = `  ${"a".repeat(MAX_INTENT_LEN)}  `;
    expect(validateIntent(padded)).toHaveLength(MAX_INTENT_LEN);
  });
});

// Minimal fake DB capturing the update path. `get()` selects the change row;
// `updateIntent` then update(...).set(...).where(...).returning() — we record the
// set payload and echo the merged row back so the assertions can inspect both.
function fakeDb(opts: { existing?: Record<string, unknown> | null }) {
  const capture: { set?: Record<string, unknown> } = {};
  const existing = opts.existing === undefined ? { id: "c1", repoId: "r1", intent: "old" } : opts.existing;
  const db = {
    select: () => ({
      from: (_t: unknown) => {
        const chain = {
          where: () => chain,
          limit: (_n: number) => Promise.resolve(existing ? [existing] : []),
          then: (res: (v: unknown[]) => void) => res(existing ? [existing] : []),
        };
        return chain;
      },
    }),
    update: (_t: unknown) => ({
      set: (vals: Record<string, unknown>) => {
        capture.set = vals;
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...(existing ?? {}), ...vals }]),
          }),
        };
      },
    }),
  };
  return { db: db as unknown as DB, capture };
}

const stubGit = {} as unknown as GitService;

describe("ChangeService.updateIntent", () => {
  it("persists the trimmed intent + a fresh updatedAt and publishes change.updated", async () => {
    const published: unknown[] = [];
    const events = { publish: async (e: unknown) => { published.push(e); } } as unknown as EventBus;
    const { db, capture } = fakeDb({ existing: { id: "c1", repoId: "r1", intent: "old" } });
    const svc = new ChangeService(db, stubGit, events);

    const updated = await svc.updateIntent("c1", "  new description  ", { kind: "human", id: "u1" });

    expect(updated.intent).toBe("new description");
    expect(capture.set?.intent).toBe("new description");
    expect(capture.set?.updatedAt).toBeInstanceOf(Date);
    expect(published).toEqual([
      { type: "change.updated", repoId: "r1", changeId: "c1", actorKind: "human", actorId: "u1", payload: { intentEdited: true } },
    ]);
  });

  it("refuses to edit the description of a closed (merged/rolled_back) change", async () => {
    const published: unknown[] = [];
    const events = { publish: async (e: unknown) => { published.push(e); } } as unknown as EventBus;
    const { db, capture } = fakeDb({ existing: { id: "c1", repoId: "r1", intent: "old", status: "merged" } });
    const svc = new ChangeService(db, stubGit, events);

    await expect(svc.updateIntent("c1", "new", { kind: "human", id: "u1" })).rejects.toThrow(ConflictError);
    expect(capture.set).toBeUndefined();
    expect(published).toEqual([]);
  });

  it("rejects an invalid intent BEFORE touching the DB", async () => {
    const events = { publish: async () => {} } as unknown as EventBus;
    const { db, capture } = fakeDb({ existing: { id: "c1", repoId: "r1", intent: "old" } });
    const svc = new ChangeService(db, stubGit, events);

    await expect(svc.updateIntent("c1", "   ", { kind: "human", id: "u1" })).rejects.toThrow(ValidationError);
    expect(capture.set).toBeUndefined();
  });

  it("throws NotFoundError when the change does not exist", async () => {
    const events = { publish: async () => {} } as unknown as EventBus;
    const { db } = fakeDb({ existing: null });
    const svc = new ChangeService(db, stubGit, events);

    await expect(svc.updateIntent("missing", "anything", { kind: "human", id: "u1" })).rejects.toThrow(NotFoundError);
  });
});
