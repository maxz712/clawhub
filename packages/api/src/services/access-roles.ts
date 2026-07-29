import { and, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { accessRoles, agents, orgMembers, roleAssignments } from "../models/schema.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import {
  DEFAULT_ROLE_DEFS, hasPermission, normalizePermissions, type Permission,
} from "./permissions.js";

/**
 * v3 RBAC (docs/redesign-v3.md §2): an access ROLE is a named permission set
 * + repo scope, assignable to any identity. For AGENTS a role is a CEILING
 * enforced at the choke points (checkPushRights for git pushes, repoAccessFor
 * for API access); an agent with no role keeps legacy grant behavior. For
 * HUMANS a role is an ADDITIVE grant (union with membership-derived access).
 * Uniform merge rights: `change:merge` grants merging at any risk, policy
 * permitting — there is no kind carve-out.
 */

export interface AccessConstraint {
  permissions: Permission[];
  repoScope: "all" | "selected";
  repoIds: string[];
}

export type AccessRoleRow = typeof accessRoles.$inferSelect;

/**
 * Seed the default roles (Admin/Developer/Reviewer/Auditor) the first time a
 * user touches the roles surface — and top up missing defaults for users who
 * seeded under v2 (which only had Developer/Reviewer).
 */
export async function ensureDefaultAccessRoles(db: DB, userId: string): Promise<AccessRoleRow[]> {
  const existing = await db.select().from(accessRoles).where(eq(accessRoles.ownerUserId, userId));
  const have = new Set(existing.filter(r => r.isBuiltin).map(r => r.name));
  for (const d of DEFAULT_ROLE_DEFS) {
    if (have.has(d.name)) continue;
    existing.push((await db.insert(accessRoles).values({
      ownerUserId: userId, name: d.name, description: d.description,
      permissions: d.permissions, repoScope: "all", repoIds: [], isBuiltin: true,
    }).returning())[0]);
  }
  return existing;
}

export interface CreateAccessRoleInput {
  name: string;
  description?: string;
  /** v3 Permission[] — or the legacy v2 {push, review} object (translated). */
  permissions?: unknown;
  repoScope?: "all" | "selected";
  repoIds?: string[];
  /** Org-scoped role: the caller must be an admin of this org. */
  orgId?: string;
}

async function requireOrgAdmin(db: DB, orgId: string, userId: string): Promise<void> {
  const m = (await db.select().from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1))[0];
  if (!m || m.role !== "admin") throw new ForbiddenError("org admin required for org-scoped roles");
}

export async function createAccessRole(db: DB, userId: string, input: CreateAccessRoleInput): Promise<AccessRoleRow> {
  const name = (input.name ?? "").trim();
  if (!name) throw new ValidationError("name required");
  if (name.length > 120) throw new ValidationError("name too long");
  const repoScope = input.repoScope === "selected" ? "selected" : "all";
  const repoIds = repoScope === "selected"
    ? (Array.isArray(input.repoIds) ? input.repoIds.filter((x): x is string => typeof x === "string").slice(0, 200) : [])
    : [];
  if (repoScope === "selected" && repoIds.length === 0) throw new ValidationError("selected scope needs at least one repo");
  if (input.orgId) await requireOrgAdmin(db, input.orgId, userId);
  const permissions = input.permissions === undefined
    ? normalizePermissions({}) // legacy default: Developer-ish
    : normalizePermissions(input.permissions);
  return (await db.insert(accessRoles).values({
    ownerUserId: input.orgId ? null : userId,
    ownerOrgId: input.orgId ?? null,
    name, description: input.description?.slice(0, 2000) ?? null,
    permissions, repoScope, repoIds,
  }).returning())[0];
}

/** Load a role the caller may MANAGE: their own, or an org role they admin. */
async function roleForManage(db: DB, userId: string, roleId: string): Promise<AccessRoleRow> {
  const row = (await db.select().from(accessRoles).where(eq(accessRoles.id, roleId)).limit(1))[0];
  if (!row) throw new NotFoundError("access role");
  if (row.ownerUserId === userId) return row;
  if (row.ownerOrgId) { await requireOrgAdmin(db, row.ownerOrgId, userId); return row; }
  throw new NotFoundError("access role");
}

export async function updateAccessRole(db: DB, userId: string, roleId: string, input: Partial<CreateAccessRoleInput>): Promise<AccessRoleRow> {
  const row = await roleForManage(db, userId, roleId);
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 120);
  if (input.description !== undefined) patch.description = input.description?.slice(0, 2000) ?? null;
  if (input.permissions !== undefined) patch.permissions = normalizePermissions(input.permissions);
  if (input.repoScope) {
    patch.repoScope = input.repoScope === "selected" ? "selected" : "all";
    patch.repoIds = patch.repoScope === "selected"
      ? (Array.isArray(input.repoIds) ? input.repoIds.filter((x): x is string => typeof x === "string").slice(0, 200) : (row.repoIds as string[]))
      : [];
  } else if (input.repoIds && row.repoScope === "selected") {
    patch.repoIds = input.repoIds.filter((x): x is string => typeof x === "string").slice(0, 200);
  }
  return (await db.update(accessRoles).set(patch).where(eq(accessRoles.id, roleId)).returning())[0];
}

export async function deleteAccessRole(db: DB, userId: string, roleId: string): Promise<void> {
  await roleForManage(db, userId, roleId);
  // #87: a role is an agent's CEILING — deleting one still referenced by an
  // agent's accessRoleId would either un-cap the agent (the old "dangling reads
  // as unconstrained" semantics, which inverted the invariant) or brick it
  // (the new fail-closed resolver). Refuse instead: re-point or archive the
  // agents first. role_assignments rows cascade with the delete as before.
  const holders = await db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(eq(agents.accessRoleId, roleId)).limit(5);
  if (holders.length) {
    throw new ConflictError(`role is still the access ceiling for agent(s): ${holders.map(h => h.name).join(", ")} — re-point them first`);
  }
  await db.delete(accessRoles).where(eq(accessRoles.id, roleId));
}

// ---- Assignments -----------------------------------------------------------

export async function assignRole(db: DB, userId: string, roleId: string, identityKind: "human" | "agent", identityId: string): Promise<void> {
  await roleForManage(db, userId, roleId);
  await db.insert(roleAssignments)
    .values({ roleId, identityKind, identityId, assignedByUserId: userId })
    .onConflictDoNothing();
}

export async function unassignRole(db: DB, userId: string, roleId: string, identityKind: "human" | "agent", identityId: string): Promise<void> {
  await roleForManage(db, userId, roleId);
  await db.delete(roleAssignments).where(and(
    eq(roleAssignments.roleId, roleId),
    eq(roleAssignments.identityKind, identityKind),
    eq(roleAssignments.identityId, identityId),
  ));
}

function rowToConstraint(role: AccessRoleRow): AccessConstraint {
  return {
    permissions: normalizePermissions(role.permissions),
    repoScope: role.repoScope === "selected" ? "selected" : "all",
    repoIds: Array.isArray(role.repoIds) ? (role.repoIds as string[]) : [],
  };
}

/**
 * Load the constraint an agent operates under, or null for legacy behavior.
 * Prefers a role_assignments row; falls back to the legacy agents.accessRoleId
 * pointer. A dangling reference is treated as no role — access control
 * degrades to the explicit-grant model, never to a lockout.
 */
export async function agentAccessConstraint(db: DB, agentId: string): Promise<AccessConstraint | null> {
  const assigned = await db.select().from(roleAssignments)
    .where(and(eq(roleAssignments.identityKind, "agent"), eq(roleAssignments.identityId, agentId)));
  if (assigned.length) {
    const roles = await db.select().from(accessRoles).where(inArray(accessRoles.id, assigned.map(a => a.roleId)));
    if (roles.length) {
      // Multiple roles: union the permissions; scope is the union of repos
      // ("all" wins). One role is the common case.
      const perms = new Set<Permission>();
      let repoScope: "all" | "selected" = "selected";
      const repoIds = new Set<string>();
      for (const r of roles) {
        const c = rowToConstraint(r);
        for (const p of c.permissions) perms.add(p);
        if (c.repoScope === "all") repoScope = "all";
        else for (const id of c.repoIds) repoIds.add(id);
      }
      return { permissions: [...perms], repoScope, repoIds: repoScope === "all" ? [] : [...repoIds] };
    }
  }
  const a = (await db.select({ accessRoleId: agents.accessRoleId }).from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  // accessRoleId NULL = deliberately roleless (legacy grant behavior, by design).
  if (!a?.accessRoleId) return null;
  const role = (await db.select().from(accessRoles).where(eq(accessRoles.id, a.accessRoleId)).limit(1))[0];
  // FAIL CLOSED (#87): a GOVERNED agent (accessRoleId set) whose role row has
  // vanished must not silently become un-capped — "agent roles are CEILINGS"
  // means losing the role can only ever RESTRICT. An empty constraint denies
  // everything beyond public read until an operator re-points the agent.
  // (deleteAccessRole also refuses to orphan a referenced role, so this is the
  // backstop for rows deleted before that guard existed.)
  if (!role) return { permissions: [], repoScope: "selected", repoIds: [] };
  return rowToConstraint(role);
}

/**
 * The ADDITIVE role grants a HUMAN holds for a given repo: the strongest
 * access level their assigned roles yield there. Never lowers membership-
 * derived access — repoAccessFor takes the max.
 */
export async function humanRoleGrants(db: DB, userId: string): Promise<AccessConstraint[]> {
  const assigned = await db.select().from(roleAssignments)
    .where(and(eq(roleAssignments.identityKind, "human"), eq(roleAssignments.identityId, userId)));
  if (!assigned.length) return [];
  const roles = await db.select().from(accessRoles).where(inArray(accessRoles.id, assigned.map(a => a.roleId)));
  return roles.map(rowToConstraint);
}

/** True when the constraint covers this repo at all. */
export function constraintCoversRepo(c: AccessConstraint, repoId: string): boolean {
  return c.repoScope === "all" || c.repoIds.includes(repoId);
}

/** Convenience: does this constraint carry a permission (with implications)? */
export function constraintHas(c: AccessConstraint, p: Permission): boolean {
  return hasPermission(c.permissions, p);
}

/** All roles visible to a user: their own + their orgs' (for listing). */
export async function listRolesFor(db: DB, userId: string): Promise<AccessRoleRow[]> {
  const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
  const orgIds = memberships.map(m => m.orgId);
  return db.select().from(accessRoles).where(
    orgIds.length
      ? or(eq(accessRoles.ownerUserId, userId), inArray(accessRoles.ownerOrgId, orgIds))
      : eq(accessRoles.ownerUserId, userId),
  );
}
