import { afterAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { hasTestDb, testDb } from "./test-db.js";
import { organizations, orgMembers, repositories, users } from "../src/models/schema.js";
import {
  assignRole, createAccessRole, ensureDefaultAccessRoles,
} from "../src/services/access-roles.js";
import { repoAccessFor, requireRepoRead } from "../src/services/repo-access.js";

// #108 regression (DB-backed): additive human role grants must be bounded by
// the GRANTING AUTHORITY. Before the fix, any user could self-assign their
// seeded builtin Admin role (permissions incl. repo:admin, repoScope "all")
// and repoAccessFor would return "admin" on EVERY repo in the instance —
// cross-tenant read/write/admin on private repos with two API calls.
describe.skipIf(!hasTestDb)("#108 role-grant escalation closed (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];

  async function mkUser(prefix: string) {
    const handle = `${prefix}-${uniq()}`;
    const [u] = await testDb.insert(users).values({
      email: `${handle}@t.local`, username: handle, passwordHash: "x",
    }).returning();
    createdUsers.push(u.id);
    return u;
  }

  afterAll(async () => {
    // users cascade to their repos' FK-free rows? repositories has no FK to
    // users — delete repos by namespaceId explicitly, then users + orgs
    // (access_roles / role_assignments cascade off users/orgs).
    if (!hasTestDb) return;
    if (createdUsers.length) {
      await testDb.delete(repositories).where(inArray(repositories.namespaceId, createdUsers));
      await testDb.delete(users).where(inArray(users.id, createdUsers));
    }
    if (createdOrgs.length) {
      await testDb.delete(repositories).where(inArray(repositories.namespaceId, createdOrgs));
      await testDb.delete(organizations).where(inArray(organizations.id, createdOrgs));
    }
  });

  it("self-assigned builtin Admin role grants nothing on another tenant's private repo", async () => {
    const victim = await mkUser("victim");
    const attacker = await mkUser("attacker");
    const [privateRepo] = await testDb.insert(repositories).values({
      name: `secret-${uniq()}`, namespaceType: "user", namespaceId: victim.id, isPublic: false,
    }).returning();

    // The exploit from the issue: seed the builtin roles, self-assign Admin.
    const roles = await ensureDefaultAccessRoles(testDb, attacker.id);
    const admin = roles.find(r => r.name === "Admin")!;
    expect(admin).toBeTruthy();
    await assignRole(testDb, attacker.id, admin.id, "human", attacker.id);

    const caller = { kind: "user", userId: attacker.id } as never;
    expect(await repoAccessFor(testDb, privateRepo, caller)).toBe("none");
    // The read gate must 404 (no existence leak), not admit.
    await expect(requireRepoRead(testDb, privateRepo, caller)).rejects.toMatchObject({ status: 404 });

    // …and the attacker's own repo is of course unaffected (owner = admin).
    const [own] = await testDb.insert(repositories).values({
      name: `mine-${uniq()}`, namespaceType: "user", namespaceId: attacker.id, isPublic: false,
    }).returning();
    expect(await repoAccessFor(testDb, own, caller)).toBe("admin");
  });

  it("a custom all-scope repo:admin role is equally inert outside the creator's authority", async () => {
    const victim = await mkUser("victim2");
    const attacker = await mkUser("attacker2");
    const [privateRepo] = await testDb.insert(repositories).values({
      name: `secret-${uniq()}`, namespaceType: "user", namespaceId: victim.id, isPublic: false,
    }).returning();

    const role = await createAccessRole(testDb, attacker.id, {
      name: "godmode", permissions: ["repo:admin"], repoScope: "all",
    });
    await assignRole(testDb, attacker.id, role.id, "human", attacker.id);

    const caller = { kind: "user", userId: attacker.id } as never;
    expect(await repoAccessFor(testDb, privateRepo, caller)).toBe("none");
  });

  it("legit additive grant still works: owner's role raises the assignee on the owner's repos", async () => {
    const owner = await mkUser("owner");
    const grantee = await mkUser("grantee");
    const [repo] = await testDb.insert(repositories).values({
      name: `proj-${uniq()}`, namespaceType: "user", namespaceId: owner.id, isPublic: false,
    }).returning();

    const role = await createAccessRole(testDb, owner.id, {
      name: "helper-reviewer", permissions: ["repo:read", "change:review"],
      repoScope: "selected", repoIds: [repo.id],
    });
    await assignRole(testDb, owner.id, role.id, "human", grantee.id);

    const caller = { kind: "user", userId: grantee.id } as never;
    expect(await repoAccessFor(testDb, repo, caller)).toBe("review");
  });

  it("org-scoped role is bounded to the org's repos; org admin's personal role reaches org repos", async () => {
    const orgAdmin = await mkUser("orgadmin");
    const member = await mkUser("member");
    const outsiderVictim = await mkUser("outsider");
    const [org] = await testDb.insert(organizations).values({ name: `org-${uniq()}` }).returning();
    createdOrgs.push(org.id);
    await testDb.insert(orgMembers).values({ orgId: org.id, userId: orgAdmin.id, role: "admin" });

    const [orgRepo] = await testDb.insert(repositories).values({
      name: `org-repo-${uniq()}`, namespaceType: "org", namespaceId: org.id, isPublic: false,
    }).returning();
    const [foreignRepo] = await testDb.insert(repositories).values({
      name: `foreign-${uniq()}`, namespaceType: "user", namespaceId: outsiderVictim.id, isPublic: false,
    }).returning();

    // Org-scoped role (created by the org admin), assigned to a non-member human:
    // reaches the org repo, never the foreign repo.
    const orgRole = await createAccessRole(testDb, orgAdmin.id, {
      name: "org-writer", permissions: ["repo:read", "repo:write"], repoScope: "all", orgId: org.id,
    });
    await assignRole(testDb, orgAdmin.id, orgRole.id, "human", member.id);
    const memberCaller = { kind: "user", userId: member.id } as never;
    expect(await repoAccessFor(testDb, orgRepo, memberCaller)).toBe("write");
    expect(await repoAccessFor(testDb, foreignRepo, memberCaller)).toBe("none");

    // A PERSONAL role owned by the org admin also covers the org's repos (the
    // owner administers them) — but still not the foreign repo.
    const personal = await createAccessRole(testDb, orgAdmin.id, {
      name: "personal-review", permissions: ["repo:read", "change:review"], repoScope: "all",
    });
    await assignRole(testDb, orgAdmin.id, personal.id, "human", member.id);
    expect(await repoAccessFor(testDb, orgRepo, memberCaller)).toBe("write"); // org role still strongest
    expect(await repoAccessFor(testDb, foreignRepo, memberCaller)).toBe("none");
  });

  it("agent ceilings unchanged: a powerful role assigned to an agent grants no access", async () => {
    const victim = await mkUser("victim3");
    const attacker = await mkUser("attacker3");
    const [privateRepo] = await testDb.insert(repositories).values({
      name: `secret-${uniq()}`, namespaceType: "user", namespaceId: victim.id, isPublic: false,
    }).returning();
    const roles = await ensureDefaultAccessRoles(testDb, attacker.id);
    const admin = roles.find(r => r.name === "Admin")!;
    // Assign to a made-up agent identity: the ceiling path must not ADD access.
    const agentId = "00000000-0000-4000-8000-000000000108";
    await assignRole(testDb, attacker.id, admin.id, "agent", agentId);
    const agentCaller = { kind: "agent", agentId } as never;
    expect(await repoAccessFor(testDb, privateRepo, agentCaller)).toBe("none");
  });
});
