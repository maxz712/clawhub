import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { accessRoles, agents } from "../models/schema.js";
import { NotFoundError, ValidationError } from "./errors.js";

/**
 * v2 agents-ux (docs/agents-ux.md): an access ROLE is a permission profile on
 * ClawHub as a whole — which repos, and what the holder may do there. Roles
 * CONSTRAIN an agent at the existing choke points (checkPushRights for git
 * pushes, repoAccessFor for API access); an agent with no role keeps legacy
 * behavior. Roles never grant merge rights — the merge gate stays policy.
 */

export interface AccessConstraint {
  permissions: { push: boolean; review: boolean };
  repoScope: "all" | "selected";
  repoIds: string[];
}

export type AccessRoleRow = typeof accessRoles.$inferSelect;

const DEFAULTS: Array<Pick<AccessRoleRow, "name" | "description"> & { permissions: AccessConstraint["permissions"] }> = [
  { name: "Developer", description: "Push code and review Changes on all your repos.", permissions: { push: true, review: true } },
  { name: "Reviewer", description: "Review Changes only — cannot push code.", permissions: { push: false, review: true } },
];

/** Seed the two default roles the first time a user touches the roles surface. */
export async function ensureDefaultAccessRoles(db: DB, userId: string): Promise<AccessRoleRow[]> {
  const existing = await db.select().from(accessRoles).where(eq(accessRoles.ownerUserId, userId));
  if (existing.length) return existing;
  const inserted: AccessRoleRow[] = [];
  for (const d of DEFAULTS) {
    inserted.push((await db.insert(accessRoles).values({
      ownerUserId: userId, name: d.name, description: d.description,
      permissions: d.permissions, repoScope: "all", repoIds: [], isBuiltin: true,
    }).returning())[0]);
  }
  return inserted;
}

export interface CreateAccessRoleInput {
  name: string;
  description?: string;
  permissions?: Partial<AccessConstraint["permissions"]>;
  repoScope?: "all" | "selected";
  repoIds?: string[];
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
  return (await db.insert(accessRoles).values({
    ownerUserId: userId, name, description: input.description?.slice(0, 2000) ?? null,
    permissions: { push: input.permissions?.push ?? true, review: input.permissions?.review ?? true },
    repoScope, repoIds,
  }).returning())[0];
}

export async function updateAccessRole(db: DB, userId: string, roleId: string, input: Partial<CreateAccessRoleInput>): Promise<AccessRoleRow> {
  const row = (await db.select().from(accessRoles)
    .where(and(eq(accessRoles.id, roleId), eq(accessRoles.ownerUserId, userId))).limit(1))[0];
  if (!row) throw new NotFoundError("access role");
  const patch: Record<string, unknown> = {};
  if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 120);
  if (input.description !== undefined) patch.description = input.description?.slice(0, 2000) ?? null;
  if (input.permissions) {
    const prev = row.permissions as AccessConstraint["permissions"];
    patch.permissions = { push: input.permissions.push ?? prev.push, review: input.permissions.review ?? prev.review };
  }
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
  const row = (await db.select().from(accessRoles)
    .where(and(eq(accessRoles.id, roleId), eq(accessRoles.ownerUserId, userId))).limit(1))[0];
  if (!row) throw new NotFoundError("access role");
  // Agents holding this role fall back to legacy (no-role) behavior — their
  // dangling accessRoleId reads as unconstrained, never as locked out.
  await db.delete(accessRoles).where(eq(accessRoles.id, roleId));
}

/**
 * Load the constraint an agent operates under, or null for legacy behavior.
 * A dangling accessRoleId (role deleted) is treated as no role — access
 * control degrades to the explicit-grant model, never to a lockout.
 */
export async function agentAccessConstraint(db: DB, agentId: string): Promise<AccessConstraint | null> {
  const a = (await db.select({ accessRoleId: agents.accessRoleId }).from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!a?.accessRoleId) return null;
  const role = (await db.select().from(accessRoles).where(eq(accessRoles.id, a.accessRoleId)).limit(1))[0];
  if (!role) return null;
  const p = role.permissions as Partial<AccessConstraint["permissions"]>;
  return {
    permissions: { push: p.push !== false, review: p.review !== false },
    repoScope: role.repoScope === "selected" ? "selected" : "all",
    repoIds: Array.isArray(role.repoIds) ? (role.repoIds as string[]) : [],
  };
}

/** True when the constraint covers this repo at all. */
export function constraintCoversRepo(c: AccessConstraint, repoId: string): boolean {
  return c.repoScope === "all" || c.repoIds.includes(repoId);
}
