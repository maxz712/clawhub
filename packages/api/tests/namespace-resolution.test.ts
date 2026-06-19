import { describe, it, expect } from "vitest";
import { resolveNamespace, namespaceNameOf } from "../src/services/namespace.js";
import { agents, organizations, users } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// Canned-row fake DB (same approach as code-tree-route.test.ts): each table
// query returns its canned rows regardless of the opaque where condition. That
// is exactly enough to assert resolution ORDER — the load-bearing invariant of
// the ownership inversion — since resolveNamespace queries users → orgs →
// agents and stops at the first match.
function fakeDb(world: { users?: unknown[]; organizations?: unknown[]; agents?: unknown[] }): DB {
  const tables: Array<[unknown, unknown[]]> = [
    [users, world.users ?? []],
    [organizations, world.organizations ?? []],
    [agents, world.agents ?? []],
  ];
  const rowsFor = (t: unknown) => tables.find(([tbl]) => tbl === t)?.[1] ?? [];
  const db = {
    select: () => ({
      from: (t: unknown) => {
        const rows = rowsFor(t);
        const chain = {
          where: () => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain;
      },
    }),
  };
  return db as unknown as DB;
}

describe("resolveNamespace ordering", () => {
  it("returns the USER when a user and a same-named agent both exist (migrated repo wins)", async () => {
    const db = fakeDb({ users: [{ id: "u1", username: "claude-code" }], agents: [{ id: "a1", name: "claude-code" }] });
    expect(await resolveNamespace(db, "claude-code")).toEqual({ kind: "user", id: "u1", name: "claude-code" });
  });

  it("returns the ORG before a same-named agent", async () => {
    const db = fakeDb({ organizations: [{ id: "o1", name: "acme" }], agents: [{ id: "a1", name: "acme" }] });
    expect(await resolveNamespace(db, "acme")).toEqual({ kind: "org", id: "o1", name: "acme" });
  });

  it("falls back to the agent namespace (transitional) when only an agent matches", async () => {
    const db = fakeDb({ agents: [{ id: "a1", name: "legacy-bot" }] });
    expect(await resolveNamespace(db, "legacy-bot")).toEqual({ kind: "agent", id: "a1", name: "legacy-bot" });
  });

  it("ignores a user with a null username — an unbackfilled user is not a namespace", async () => {
    const db = fakeDb({ users: [{ id: "u1", username: null }], agents: [{ id: "a1", name: "x" }] });
    expect(await resolveNamespace(db, "x")).toEqual({ kind: "agent", id: "a1", name: "x" });
  });

  it("returns null when nothing matches", async () => {
    expect(await resolveNamespace(fakeDb({}), "nobody")).toBeNull();
  });
});

describe("namespaceNameOf", () => {
  it("maps each kind to its display name", async () => {
    const db = fakeDb({ users: [{ id: "u1", username: "alice" }], organizations: [{ id: "o1", name: "acme" }], agents: [{ id: "a1", name: "bot" }] });
    expect(await namespaceNameOf(db, "user", "u1")).toBe("alice");
    expect(await namespaceNameOf(db, "org", "o1")).toBe("acme");
    expect(await namespaceNameOf(db, "agent", "a1")).toBe("bot");
  });

  it("returns null for a missing namespace", async () => {
    expect(await namespaceNameOf(fakeDb({}), "user", "missing")).toBeNull();
  });
});
