import { describe, it, expect } from "vitest";
import { agents, orgMembers, repoCollaborators } from "../src/models/schema.js";
import { repoAccessFor, requireRepoRead, requireRepoWrite, requireRepoAdmin } from "../src/services/repo-access.js";

// Fake DB: returns canned rows per TABLE (keyed off .from(table)). We test the
// access LOGIC, not Drizzle's WHERE filtering — so each table just yields the
// rows the scenario should "find". The .where() result is both awaitable (for
// the no-limit owned-agents query) and exposes .limit() (for the rest).
function makeDb(data: { orgMembers?: unknown[]; agents?: unknown[]; repoCollaborators?: unknown[] }) {
  const pick = (table: unknown): unknown[] =>
    table === orgMembers ? (data.orgMembers ?? [])
    : table === agents ? (data.agents ?? [])
    : table === repoCollaborators ? (data.repoCollaborators ?? [])
    : [];
  return {
    select() {
      return {
        from(table: unknown) {
          const rows = pick(table);
          return {
            where() {
              return {
                limit: () => Promise.resolve(rows),
                then: (res: (v: unknown[]) => void, rej: (e: unknown) => void) => Promise.resolve(rows).then(res, rej),
              };
            },
          };
        },
      };
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const userRepo = (ownerId: string, isPublic = false) => ({ id: "repo1", name: "r", namespaceType: "user", namespaceId: ownerId, isPublic } as any);
const orgRepo = (orgId: string, isPublic = false) => ({ id: "repo1", name: "r", namespaceType: "org", namespaceId: orgId, isPublic } as any);
const asUser = (userId: string) => ({ kind: "user", userId } as any);
const asAgent = (agentId: string) => ({ kind: "agent", agentId } as any);

describe("repoAccessFor", () => {
  it("user owning the user-namespace repo → admin", async () => {
    expect(await repoAccessFor(makeDb({}), userRepo("U1"), asUser("U1"))).toBe("admin");
  });

  it("user with no membership on a PRIVATE repo → none", async () => {
    expect(await repoAccessFor(makeDb({}), userRepo("U1", false), asUser("U2"))).toBe("none");
  });

  it("user with no membership on a PUBLIC repo → read", async () => {
    expect(await repoAccessFor(makeDb({}), userRepo("U1", true), asUser("U2"))).toBe("read");
  });

  it("org admin → admin, org member → write", async () => {
    expect(await repoAccessFor(makeDb({ orgMembers: [{ role: "admin" }] }), orgRepo("O1"), asUser("U1"))).toBe("admin");
    expect(await repoAccessFor(makeDb({ orgMembers: [{ role: "member" }] }), orgRepo("O1"), asUser("U1"))).toBe("write");
  });

  it("user who owns an agent that collaborates → write", async () => {
    const db = makeDb({ agents: [{ id: "A1" }], repoCollaborators: [{ role: "writer" }] });
    expect(await repoAccessFor(db, userRepo("U-other"), asUser("U1"))).toBe("write");
  });

  it("agent with a writer grant → write; reviewer grant → review (strictly lower, cannot push)", async () => {
    expect(await repoAccessFor(makeDb({ repoCollaborators: [{ role: "writer" }] }), userRepo("U1"), asAgent("A1"))).toBe("write");
    // A `reviewer` grant is read+review only — strictly below write. It must NOT
    // resolve to write (that let a review-only agent push / merge / manage secrets).
    expect(await repoAccessFor(makeDb({ repoCollaborators: [{ role: "reviewer" }] }), userRepo("U1"), asAgent("A1"))).toBe("review");
  });

  it("agent claimed by / service-user of the owning user → write", async () => {
    const db = makeDb({ agents: [{ id: "A1", associatedUserId: "U1", serviceUserId: null }] });
    expect(await repoAccessFor(db, userRepo("U1"), asAgent("A1"))).toBe("write");
  });

  it("agent with no grant on a PRIVATE repo → none; PUBLIC → read", async () => {
    expect(await repoAccessFor(makeDb({ agents: [{ id: "A1" }] }), userRepo("U1", false), asAgent("A1"))).toBe("none");
    expect(await repoAccessFor(makeDb({ agents: [{ id: "A1" }] }), userRepo("U1", true), asAgent("A1"))).toBe("read");
  });

  // Batch 9: a HUMAN granted a direct collaborator row on ONE repo (no org
  // membership, owns no collaborating agent) gets that grant's level. `agents:[]`
  // means the only access source is the human grant.
  it("user with a direct human-collaborator writer grant → write", async () => {
    const db = makeDb({ agents: [], repoCollaborators: [{ role: "writer" }] });
    expect(await repoAccessFor(db, userRepo("U-other", false), asUser("U2"))).toBe("write");
  });
  it("user with a direct human-collaborator reviewer grant → review (cannot push/merge)", async () => {
    const db = makeDb({ agents: [], repoCollaborators: [{ role: "reviewer" }] });
    expect(await repoAccessFor(db, userRepo("U-other", false), asUser("U2"))).toBe("review");
  });
});

describe("require* gates", () => {
  it("requireRepoRead throws 404 (NotFound) on no access — does not leak existence", async () => {
    await expect(requireRepoRead(makeDb({}), userRepo("U1", false), asUser("U2"))).rejects.toMatchObject({ status: 404 });
  });
  it("requireRepoWrite throws 403 when caller can only read", async () => {
    await expect(requireRepoWrite(makeDb({}), userRepo("U1", true), asUser("U2"))).rejects.toMatchObject({ status: 403 });
  });
  it("requireRepoWrite throws 404 when caller has no access at all", async () => {
    await expect(requireRepoWrite(makeDb({}), userRepo("U1", false), asUser("U2"))).rejects.toMatchObject({ status: 404 });
  });
  it("requireRepoAdmin allows the owner, blocks a writer (403)", async () => {
    expect(await requireRepoAdmin(makeDb({}), userRepo("U1"), asUser("U1"))).toBe("admin");
    await expect(requireRepoAdmin(makeDb({ repoCollaborators: [{ role: "writer" }] }), userRepo("U-other"), asAgent("A1")))
      .rejects.toMatchObject({ status: 403 });
  });
});
