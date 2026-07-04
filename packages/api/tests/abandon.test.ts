import { describe, it, expect } from "vitest";
import { ChangeService } from "../src/services/changes.js";
import { changes } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";
import type { EventBus } from "../src/services/events.js";

// Fake DB (same shape as batch6-reopen-raw): records the writes/events the method
// emits, without a real connection, so the abandon state machine is unit-testable.
interface Rec { updates: Array<{ table: string; vals: Record<string, unknown> }>; published: unknown[] }
function makeDb(changeRow: Record<string, unknown> | null, rec: Rec): DB {
  const db = {
    select: (_c?: unknown) => ({ from: (t: unknown) => {
      const rows = t === changes && changeRow ? [changeRow] : [];
      const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)), then: (r: (v: unknown[]) => void) => r(rows) };
      return chain as typeof chain & PromiseLike<unknown[]>;
    } }),
    update: (t: unknown) => ({ set: (vals: Record<string, unknown>) => ({ where: () => {
      rec.updates.push({ table: t === changes ? "changes" : "?", vals });
      return Promise.resolve();
    } }) }),
    insert: () => ({ values: () => Promise.resolve() }), // audit-log record is a no-op here
  };
  return db as unknown as DB;
}
const evbus = (rec: Rec) => ({ publish: async (e: unknown) => { rec.published.push(e); } } as unknown as EventBus);

describe("ChangeService.abandon", () => {
  it("abandons an unmerged change → status 'abandoned' + publishes change.abandoned", async () => {
    const rec: Rec = { updates: [], published: [] };
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "pending", openedByAgentId: null, openedByUserId: "u1" }, rec), {} as GitService, evbus(rec));
    await svc.abandon("ch1", { kind: "human", id: "u1" }, { reason: "garbage diff" });
    expect(rec.updates.find(u => u.table === "changes")?.vals).toMatchObject({ status: "abandoned" });
    expect(rec.published[0]).toMatchObject({ type: "change.abandoned", changeId: "ch1" });
  });

  it("refuses to abandon a MERGED change (must use rollback)", async () => {
    const rec: Rec = { updates: [], published: [] };
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "merged" }, rec), {} as GitService, evbus(rec));
    await expect(svc.abandon("ch1", { kind: "human", id: "u1" })).rejects.toThrow();
    expect(rec.updates).toHaveLength(0);
    expect(rec.published).toHaveLength(0);
  });

  it("is idempotent on an already-abandoned change (no write, no event)", async () => {
    const rec: Rec = { updates: [], published: [] };
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "abandoned" }, rec), {} as GitService, evbus(rec));
    await svc.abandon("ch1", { kind: "human", id: "u1" });
    expect(rec.updates).toHaveLength(0);
    expect(rec.published).toHaveLength(0);
  });

  it("reopen un-abandons → back to pending", async () => {
    const rec: Rec = { updates: [], published: [] };
    const svc = new ChangeService(makeDb({ id: "ch1", repoId: "r1", status: "abandoned" }, rec), {} as GitService, evbus(rec));
    await svc.reopen("ch1", { kind: "human", id: "u1" });
    expect(rec.updates.find(u => u.table === "changes")?.vals).toMatchObject({ status: "pending" });
    expect(rec.published[0]).toMatchObject({ type: "change.updated", payload: { reopened: true } });
  });
});
