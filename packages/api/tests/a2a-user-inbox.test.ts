import { describe, it, expect } from "vitest";
import { userInbox } from "../src/services/agent-inbox.js";
import { agents, agentMessages } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// FEATURE 3 — human-supervision read of the A2A inbox across a user's agents.
// `userInbox` is the load-bearing helper: it resolves the caller's owned/claimed
// agents, unions their messages, and labels each with the owning agent. The
// canned-row fake DB (same approach as code-tree-route.test.ts) ignores the
// opaque WHERE/ORDER BY/LIMIT and returns the table's rows, which is exactly
// enough to assert the union + per-agent labeling + the empty-fleet short
// circuit — the invariants this feature adds.
function fakeDb(world: { agents?: unknown[]; agentMessages?: unknown[] }): DB {
  const rowsFor = (t: unknown): unknown[] => {
    if (t === agents) return world.agents ?? [];
    if (t === agentMessages) return world.agentMessages ?? [];
    return [];
  };
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = rowsFor(t);
        const chain = {
          where: (_c: unknown) => chain,
          orderBy: (_o: unknown) => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
  };
  return db as unknown as DB;
}

const msg = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "m1", toAgentId: "ag1", fromKind: "agent", fromId: "ag2", changeId: null,
  kind: "handoff", body: { summary: "hi" }, read: false,
  createdAt: new Date("2026-06-22T00:00:00Z"), ...over,
});

describe("userInbox", () => {
  it("returns no messages — and queries nothing further — when the user owns no agents", async () => {
    // Empty fleet must short-circuit: never widen to all messages.
    const msgs = await userInbox(fakeDb({ agents: [], agentMessages: [msg()] }), "u1");
    expect(msgs).toEqual([]);
  });

  it("unions messages across the caller's agents and labels each with its agent name", async () => {
    const db = fakeDb({
      agents: [{ id: "ag1", name: "alpha" }, { id: "ag2", name: "beta" }],
      agentMessages: [msg({ id: "m1", toAgentId: "ag1" }), msg({ id: "m2", toAgentId: "ag2" })],
    });
    const msgs = await userInbox(db, "u1");
    expect(msgs.map(m => m.id)).toEqual(["m1", "m2"]);
    expect(msgs.map(m => ({ agentId: m.agentId, agentName: m.agentName }))).toEqual([
      { agentId: "ag1", agentName: "alpha" },
      { agentId: "ag2", agentName: "beta" },
    ]);
    // The full underlying message is preserved alongside the annotation.
    expect(msgs[0].kind).toBe("handoff");
    expect(msgs[0].body).toEqual({ summary: "hi" });
  });

  it("labels a message addressed to an agent outside the fleet with an empty name", async () => {
    // Defensive: the WHERE clause scopes rows to the fleet in production, but the
    // mapping must not crash if an unexpected toAgentId slips through.
    const db = fakeDb({
      agents: [{ id: "ag1", name: "alpha" }],
      agentMessages: [msg({ id: "m1", toAgentId: "ag9" })],
    });
    const msgs = await userInbox(db, "u1");
    expect(msgs[0].agentName).toBe("");
    expect(msgs[0].agentId).toBe("ag9");
  });

  it("honors the limit option (newest-first ordering is delegated to the query)", async () => {
    const db = fakeDb({
      agents: [{ id: "ag1", name: "alpha" }],
      agentMessages: [msg({ id: "m1" }), msg({ id: "m2" }), msg({ id: "m3" })],
    });
    const msgs = await userInbox(db, "u1", { limit: 2 });
    expect(msgs.map(m => m.id)).toEqual(["m1", "m2"]);
  });
});
