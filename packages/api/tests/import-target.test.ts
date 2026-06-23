import { describe, it, expect } from "vitest";
import { resolveImportOwner } from "../src/services/namespace.js";
import { AppError } from "../src/services/errors.js";
import { agents, orgMembers, organizations, users } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// Canned-row fake DB (same approach as namespace-resolution.test.ts /
// code-tree-route.test.ts): each table query returns its canned rows regardless
// of the opaque where condition. resolveImportOwner only branches on the rows it
// reads + the agent argument, so this is enough to assert the authorization gate
// — the load-bearing invariant for source-import target selection.
function fakeDb(world: {
  users?: unknown[]; organizations?: unknown[]; agents?: unknown[]; orgMembers?: unknown[];
}): DB {
  const tables: Array<[unknown, unknown[]]> = [
    [users, world.users ?? []],
    [organizations, world.organizations ?? []],
    [agents, world.agents ?? []],
    [orgMembers, world.orgMembers ?? []],
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
    // ensureServiceUserForAgent updates agents.serviceUserId when it provisions
    // a fresh service account; the default-namespace cases below preseed it so no
    // insert/update is exercised.
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
  return db as unknown as DB;
}

type Agent = typeof agents.$inferSelect;
function agent(over: Partial<Agent>): Agent {
  return { id: "a1", name: "bot", associatedUserId: null, serviceUserId: null, ...over } as Agent;
}

async function expectForbidden(p: Promise<unknown>, code?: string): Promise<void> {
  await expect(p).rejects.toMatchObject({ status: 403, ...(code ? { code } : {}) });
}

describe("resolveImportOwner", () => {
  it("defaults to the agent's own service-user namespace when targetNamespace is omitted", async () => {
    const db = fakeDb({});
    const a = agent({ id: "a1", name: "bot", serviceUserId: "svc-bot" });
    const owner = await resolveImportOwner(db, a);
    expect(owner).toEqual({ ownerKind: "user", ownerId: "svc-bot", diskNamespace: "bot" });
  });

  it("treats targetNamespace === agent.name as the default (no resolution needed)", async () => {
    const db = fakeDb({});
    const a = agent({ id: "a1", name: "bot", serviceUserId: "svc-bot" });
    const owner = await resolveImportOwner(db, a, "bot");
    expect(owner).toEqual({ ownerKind: "user", ownerId: "svc-bot", diskNamespace: "bot" });
  });

  it("allows importing into the user namespace that CLAIMS the agent", async () => {
    const db = fakeDb({ users: [{ id: "u1", username: "alice" }] });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    const owner = await resolveImportOwner(db, a, "alice");
    expect(owner).toEqual({ ownerKind: "user", ownerId: "u1", diskNamespace: "alice" });
  });

  it("rejects (403) importing into a user namespace that does NOT own the agent", async () => {
    const db = fakeDb({ users: [{ id: "u2", username: "bob" }] });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expectForbidden(resolveImportOwner(db, a, "bob"));
  });

  it("allows an org namespace when the agent's human is an ADMIN member", async () => {
    const db = fakeDb({
      organizations: [{ id: "o1", name: "acme" }],
      orgMembers: [{ orgId: "o1", userId: "u1", role: "admin" }],
    });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    const owner = await resolveImportOwner(db, a, "acme");
    expect(owner).toEqual({ ownerKind: "org", ownerId: "o1", diskNamespace: "acme" });
  });

  it("rejects (403, org_admin_required) when the agent's human is a non-admin org member", async () => {
    const db = fakeDb({
      organizations: [{ id: "o1", name: "acme" }],
      orgMembers: [{ orgId: "o1", userId: "u1", role: "member" }],
    });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expectForbidden(resolveImportOwner(db, a, "acme"), "org_admin_required");
  });

  it("rejects (403) an org import when the agent is unclaimed (no human)", async () => {
    const db = fakeDb({ organizations: [{ id: "o1", name: "acme" }] });
    const a = agent({ id: "a1", name: "bot", associatedUserId: null });
    await expectForbidden(resolveImportOwner(db, a, "acme"));
  });

  it("rejects (403) an org import when the agent's human is not a member at all", async () => {
    const db = fakeDb({ organizations: [{ id: "o1", name: "acme" }], orgMembers: [] });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expectForbidden(resolveImportOwner(db, a, "acme"));
  });

  it("404s an unknown target namespace (no existence leak)", async () => {
    const db = fakeDb({});
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expect(resolveImportOwner(db, a, "ghost")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects (403) importing into a legacy agent namespace that isn't the caller's own", async () => {
    const db = fakeDb({ agents: [{ id: "a2", name: "other-bot" }] });
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expectForbidden(resolveImportOwner(db, a, "other-bot"));
  });

  it("threw errors are AppError subclasses (mapped to HTTP by errorHandler)", async () => {
    const db = fakeDb({});
    const a = agent({ id: "a1", name: "bot", associatedUserId: "u1" });
    await expect(resolveImportOwner(db, a, "ghost")).rejects.toBeInstanceOf(AppError);
  });
});
