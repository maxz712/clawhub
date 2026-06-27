import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, organizations, users } from "../models/schema.js";
import { randomToken } from "./auth.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import { ensureServiceUserForAgent } from "./auto-repo.js";

export type NamespaceKind = "user" | "org" | "agent";

export interface ResolvedNamespace {
  kind: NamespaceKind;
  id: string;
  name: string;
}

/**
 * Resolve a bare namespace name to its owning entity.
 *
 * Users and orgs OWN repos. The `agent` namespace is **transitional** — it only
 * matches legacy agent-owned repos predating the ownership inversion, and is
 * tried LAST. That ordering is load-bearing: after a repo is migrated to a
 * same-named service-account USER, both a `users.username` and the original
 * `agents.name` exist for that string; users-first guarantees the migrated
 * (user-owned) repo resolves instead of 404-ing against the stale agent
 * namespace. Once no agent-owned repos remain, the agent branch is removed so a
 * name can never again resolve to an agent namespace ("agents never own").
 */
export async function resolveNamespace(db: DB, name: string): Promise<ResolvedNamespace | null> {
  const user = (await db.select().from(users).where(eq(users.username, name)).limit(1))[0];
  if (user?.username) return { kind: "user", id: user.id, name: user.username };
  const org = (await db.select().from(organizations).where(eq(organizations.name, name)).limit(1))[0];
  if (org) return { kind: "org", id: org.id, name: org.name };
  const agent = (await db.select().from(agents).where(eq(agents.name, name)).limit(1))[0];
  if (agent) return { kind: "agent", id: agent.id, name: agent.name };
  return null;
}

/**
 * Map a (kind, id) namespace tuple back to its display name. Returns null if the
 * row is missing. The single 3-kind id→name lookup used everywhere a repo's
 * namespace must be rendered or turned into an on-disk path.
 */
export async function namespaceNameOf(db: DB, kind: NamespaceKind, id: string): Promise<string | null> {
  if (kind === "user") {
    const u = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
    return u?.username ?? null;
  }
  if (kind === "org") {
    const o = (await db.select().from(organizations).where(eq(organizations.id, id)).limit(1))[0];
    return o?.name ?? null;
  }
  const a = (await db.select().from(agents).where(eq(agents.id, id)).limit(1))[0];
  return a?.name ?? null;
}

/**
 * Derive a globally-unique handle for a human user from their email local part.
 * A username becomes a resolvable namespace, so uniqueness is checked across
 * users, agents, AND orgs. Returns a sanitized base, with a short random suffix
 * on collision.
 */
export async function deriveUniqueUsername(db: DB, email: string): Promise<string> {
  const local = email.split("@")[0] ?? "user";
  let base = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  if (!base) base = "user";
  if (!(await handleTaken(db, base))) return base;
  for (let i = 0; i < 5; i++) {
    const suffix = randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4);
    const candidate = `${base}-${suffix}`.slice(0, 60);
    if (!(await handleTaken(db, candidate))) return candidate;
  }
  return `${base}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)}`.slice(0, 60);
}

/**
 * Ensure a human user has a resolvable handle (username), deriving + persisting
 * one from their email on first need. Idempotent — returns the existing handle.
 * A handle is required for human git push (it's the namespace in the push URL)
 * and for display, so login/personal-agent/me all funnel through here.
 */
export async function ensureUserHandle(db: DB, userId: string, email: string, knownUsername?: string | null): Promise<string> {
  // Callers that already loaded the user row (login, /me) pass its username so we
  // skip a redundant SELECT. `undefined` = unknown (do the lookup); an explicit
  // `null` = known-absent (mint without the lookup).
  if (knownUsername) return knownUsername;
  if (knownUsername === undefined) {
    const u = (await db.select({ username: users.username }).from(users).where(eq(users.id, userId)).limit(1))[0];
    if (u?.username) return u.username;
  }
  const handle = await deriveUniqueUsername(db, email);
  await db.update(users).set({ username: handle }).where(eq(users.id, userId));
  return handle;
}

/** True if a name is already taken as a username, agent name, or org name. */
export async function handleTaken(db: DB, name: string): Promise<boolean> {
  if ((await db.select({ id: users.id }).from(users).where(eq(users.username, name)).limit(1))[0]) return true;
  if ((await db.select({ id: agents.id }).from(agents).where(eq(agents.name, name)).limit(1))[0]) return true;
  if ((await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, name)).limit(1))[0]) return true;
  return false;
}

/**
 * Where a repo created by an agent will live. Repos are never owned by an agent —
 * `ownerKind`/`ownerId` is the USER (human or service-account) or ORG namespace
 * that owns the repo; `diskNamespace` is the on-disk path segment (the namespace
 * NAME). For the legacy default — an agent's own service account — the disk name
 * is the agent's name (the service user shares it), matching auto-repo.
 */
export interface ImportOwner {
  ownerKind: "user" | "org";
  ownerId: string;
  diskNamespace: string;
}

/**
 * Resolve AND authorize where an agent-driven source-import should create its
 * repo, mirroring auto-repo's create gate (the single place "may this agent
 * create a repo in this namespace" is decided):
 *
 *  - `targetNamespace` omitted → the agent's own same-named service-account user
 *    (the historical default — unchanged behavior).
 *  - a USER namespace → allowed only when the agent is claimed by that user, or
 *    it IS that user's service account.
 *  - an ORG namespace → allowed only when the agent's claiming human is an ADMIN
 *    member of the org (creating a repo under an org is an admin action).
 *
 * A namespace that does not resolve, or a legacy `agent` namespace that is not
 * the caller's own, is rejected. A read-style failure (unknown namespace) throws
 * NotFoundError so we never leak which namespaces exist; an authorization
 * failure throws ForbiddenError.
 */
export async function resolveImportOwner(
  db: DB,
  agent: typeof agents.$inferSelect,
  targetNamespace?: string,
): Promise<ImportOwner> {
  if (!targetNamespace || targetNamespace === agent.name) {
    const ownerId = await ensureServiceUserForAgent(db, agent);
    return { ownerKind: "user", ownerId, diskNamespace: agent.name };
  }

  const ns = await resolveNamespace(db, targetNamespace);
  if (!ns) throw new NotFoundError(`namespace ${targetNamespace}`);

  if (ns.kind === "user") {
    if (agent.associatedUserId !== ns.id && agent.serviceUserId !== ns.id) {
      throw new ForbiddenError("agent not authorized to import into this namespace");
    }
    return { ownerKind: "user", ownerId: ns.id, diskNamespace: ns.name };
  }

  if (ns.kind === "org") {
    if (!agent.associatedUserId) throw new ForbiddenError("agent not authorized to import into this org");
    const member = (await db.select().from(orgMembers).where(and(
      eq(orgMembers.orgId, ns.id),
      eq(orgMembers.userId, agent.associatedUserId),
    )).limit(1))[0];
    if (!member) throw new ForbiddenError("agent not authorized to import into this org");
    if (member.role !== "admin") throw new ForbiddenError("only an org admin can import a repo into this org namespace", "org_admin_required");
    return { ownerKind: "org", ownerId: ns.id, diskNamespace: ns.name };
  }

  // Legacy `agent` namespace that isn't the caller's own — agents never own.
  throw new ForbiddenError("agents can only import into their own namespace");
}
