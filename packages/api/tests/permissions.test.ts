import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_DEFS, expandPermissions, hasPermission, normalizePermissions, PERMISSIONS,
} from "../src/services/permissions.js";
import { hasTestDb, testDb } from "./test-db.js";
import { accessRoles, agents, repoCollaborators, repositories, roleAssignments, users } from "../src/models/schema.js";
import { repoAccessFor, requireMergeRights } from "../src/services/repo-access.js";
import { agentAccessConstraint, assignRole } from "../src/services/access-roles.js";

// v3 RBAC (docs/redesign-v3.md §2): permission catalog + uniform merge rights.

describe("permissions catalog (pure)", () => {
  it("normalizes the legacy {push, review} object", () => {
    const p = normalizePermissions({ push: true, review: true });
    expect(hasPermission(p, "repo:write")).toBe(true);
    expect(hasPermission(p, "change:review")).toBe(true);
    expect(hasPermission(p, "change:merge")).toBe(false); // legacy never granted merge
  });

  it("legacy review-only maps to no push", () => {
    const p = normalizePermissions({ push: false, review: true });
    expect(hasPermission(p, "repo:write")).toBe(false);
    expect(hasPermission(p, "change:review")).toBe(true);
  });

  it("filters unknown keys from arrays and dedupes", () => {
    expect(normalizePermissions(["repo:read", "bogus", "repo:read"])).toEqual(["repo:read"]);
  });

  it("garbage errs safe to read-only", () => {
    expect(normalizePermissions("nope")).toEqual(["repo:read"]);
  });

  it("implications: repo:admin covers the write ladder and ops", () => {
    const p = expandPermissions(["repo:admin"]);
    for (const k of ["repo:write", "repo:read", "change:write", "change:read", "policy:write", "ops:kill"] as const) {
      expect(p.has(k)).toBe(true);
    }
    expect(p.has("change:merge")).toBe(false); // merge is explicit, never implied
  });

  it("Developer default carries no merge; Admin carries everything", () => {
    const dev = DEFAULT_ROLE_DEFS.find(d => d.name === "Developer")!;
    expect(hasPermission(dev.permissions, "change:merge")).toBe(false);
    expect(hasPermission(dev.permissions, "repo:write")).toBe(true);
    const admin = DEFAULT_ROLE_DEFS.find(d => d.name === "Admin")!;
    for (const k of PERMISSIONS) expect(hasPermission(admin.permissions, k)).toBe(true);
  });

  it("Reviewer default: review + audit, no push, no merge", () => {
    const r = DEFAULT_ROLE_DEFS.find(d => d.name === "Reviewer")!;
    expect(hasPermission(r.permissions, "change:review")).toBe(true);
    expect(hasPermission(r.permissions, "audit:read")).toBe(true);
    expect(hasPermission(r.permissions, "repo:write")).toBe(false);
    expect(hasPermission(r.permissions, "change:merge")).toBe(false);
  });
});

describe.skipIf(!hasTestDb)("uniform merge rights + role enforcement (db)", () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  async function mkUser(username: string) {
    return (await testDb.insert(users).values({ email: `${username}@t.local`, username, passwordHash: "x" }).returning())[0];
  }
  async function mkRepo(ownerUserId: string) {
    return (await testDb.insert(repositories).values({ name: `r-${uniq()}`, namespaceType: "user", namespaceId: ownerUserId }).returning())[0];
  }
  async function mkAgent(name: string, ownerId: string, accessRoleId?: string) {
    return (await testDb.insert(agents).values({
      name, tokenHash: "x", gitAuthorName: name, gitAuthorEmail: `${name}@a.local`,
      associatedUserId: ownerId, accessRoleId: accessRoleId ?? null,
    }).returning())[0];
  }

  it("an agent with change:merge in its role may merge — at any risk (role question only)", async () => {
    const owner = await mkUser(`o-${uniq()}`);
    const repo = await mkRepo(owner.id);
    const [role] = await testDb.insert(accessRoles).values({
      ownerUserId: owner.id, name: `merge-${uniq()}`,
      permissions: ["repo:read", "repo:write", "change:merge"], repoScope: "all", repoIds: [],
    }).returning();
    const agent = await mkAgent(`m-${uniq()}`, owner.id, role.id);
    await testDb.insert(repoCollaborators).values({ repoId: repo.id, agentId: agent.id, role: "writer" });
    const caller = { kind: "agent" as const, agentId: agent.id, name: agent.name };
    const access = await repoAccessFor(testDb, repo, caller);
    expect(access).toBe("write");
    await expect(requireMergeRights(testDb, repo, caller, access)).resolves.toBeUndefined();
  });

  it("an agent whose role lacks change:merge is refused (403), even with write access", async () => {
    const owner = await mkUser(`o-${uniq()}`);
    const repo = await mkRepo(owner.id);
    const [role] = await testDb.insert(accessRoles).values({
      ownerUserId: owner.id, name: `dev-${uniq()}`,
      permissions: ["repo:read", "repo:write", "change:write"], repoScope: "all", repoIds: [],
    }).returning();
    const agent = await mkAgent(`d-${uniq()}`, owner.id, role.id);
    await testDb.insert(repoCollaborators).values({ repoId: repo.id, agentId: agent.id, role: "writer" });
    const caller = { kind: "agent" as const, agentId: agent.id, name: agent.name };
    const access = await repoAccessFor(testDb, repo, caller);
    expect(access).toBe("write");
    await expect(requireMergeRights(testDb, repo, caller, access)).rejects.toThrow(/change:merge/);
  });

  it("a role-less agent keeps legacy behavior: write access admits merge", async () => {
    const owner = await mkUser(`o-${uniq()}`);
    const repo = await mkRepo(owner.id);
    const agent = await mkAgent(`l-${uniq()}`, owner.id);
    await testDb.insert(repoCollaborators).values({ repoId: repo.id, agentId: agent.id, role: "writer" });
    const caller = { kind: "agent" as const, agentId: agent.id, name: agent.name };
    const access = await repoAccessFor(testDb, repo, caller);
    await expect(requireMergeRights(testDb, repo, caller, access)).resolves.toBeUndefined();
  });

  it("role assignments (role_assignments) constrain agents like the legacy pointer", async () => {
    const owner = await mkUser(`o-${uniq()}`);
    const [role] = await testDb.insert(accessRoles).values({
      ownerUserId: owner.id, name: `assigned-${uniq()}`,
      permissions: ["repo:read", "change:review"], repoScope: "all", repoIds: [],
    }).returning();
    const agent = await mkAgent(`a-${uniq()}`, owner.id);
    await assignRole(testDb, owner.id, role.id, "agent", agent.id);
    const c = await agentAccessConstraint(testDb, agent.id);
    expect(c).not.toBeNull();
    expect(c!.permissions).toContain("change:review");
    expect(c!.permissions).not.toContain("repo:write");
  });

  it("a human role assignment is ADDITIVE: Reviewer role grants review on a stranger's repo", async () => {
    const owner = await mkUser(`o-${uniq()}`);
    const outsider = await mkUser(`x-${uniq()}`);
    const repo = await mkRepo(owner.id);
    // Private repo, outsider has no membership: none.
    expect(await repoAccessFor(testDb, repo, { kind: "user", userId: outsider.id, email: "x@t.local" })).toBe("none");
    const [role] = await testDb.insert(accessRoles).values({
      ownerUserId: owner.id, name: `rev-${uniq()}`,
      permissions: ["repo:read", "change:review"], repoScope: "selected", repoIds: [repo.id],
    }).returning();
    await testDb.insert(roleAssignments).values({ roleId: role.id, identityKind: "human", identityId: outsider.id });
    expect(await repoAccessFor(testDb, repo, { kind: "user", userId: outsider.id, email: "x@t.local" })).toBe("review");
    // Additive never lowers: the owner stays admin regardless of any role.
    expect(await repoAccessFor(testDb, repo, { kind: "user", userId: owner.id, email: "o@t.local" })).toBe("admin");
  });
});
