import { and, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, publicActivity, repoCollaborators, repositories, users } from "../models/schema.js";

/**
 * v3 identities (docs/redesign-v3.md §1): humans and agents are one
 * conceptual record — a PROJECTION over the users + agents tables, never a
 * table merge (token semantics differ; the tables keep their mechanics).
 * The directory, profiles, and audit key on this shape.
 *
 * Visibility is COMMON CONTEXT: the directory lists only identities that
 * share a repo with the caller (owner, org member, collaborator, or author
 * of activity there). A non-shared identity is a 404 — never "exists but
 * hidden" — mirroring the repo-access convention.
 */

export interface Identity {
  id: string;
  kind: "human" | "agent";
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  isSystem: boolean;
  /** For agents: the governing human (associated or creating user). */
  ownerUserId: string | null;
  createdAt: Date | string | null;
}

type UserRow = typeof users.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export function userToIdentity(u: UserRow): Identity {
  return {
    id: u.id,
    kind: "human",
    handle: u.username ?? `user-${u.id.slice(0, 8)}`,
    displayName: u.name ?? u.username ?? null,
    avatarUrl: u.avatarUrl ?? null,
    bio: u.bio ?? null,
    isSystem: false,
    ownerUserId: null,
    createdAt: u.createdAt,
  };
}

export function agentToIdentity(a: AgentRow): Identity {
  return {
    id: a.id,
    kind: "agent",
    handle: a.name,
    displayName: a.gitAuthorName ?? a.name,
    avatarUrl: a.avatarUrl ?? null,
    bio: a.bio ?? null,
    isSystem: !!a.isSystem,
    ownerUserId: a.associatedUserId ?? a.createdByUserId ?? null,
    createdAt: a.createdAt,
  };
}

export function identityKey(kind: "human" | "agent", id: string): string {
  return `${kind}:${id}`;
}

/**
 * Resolve a handle to an identity — users first, then agents, mirroring
 * `namespace.ts:resolveNamespace`'s load-bearing order (a user always wins
 * over a same-named agent). Archived agents don't resolve.
 */
export async function identityByHandle(db: DB, handle: string): Promise<Identity | null> {
  const u = (await db.select().from(users).where(eq(users.username, handle)).limit(1))[0];
  if (u && u.kind === "human") return userToIdentity(u);
  const a = (await db.select().from(agents).where(eq(agents.name, handle)).limit(1))[0];
  if (a && !a.archivedAt) return agentToIdentity(a);
  return null;
}

type RepoRow = typeof repositories.$inferSelect;

/**
 * Every repo the caller can read as a member of it: their own namespace,
 * their claimed agents' service namespaces, their orgs', legacy agent-owned,
 * plus single-repo human collaborator grants. (Public repos the caller has
 * no tie to are deliberately NOT here — being able to read a public repo
 * does not put its strangers in your directory.)
 */
export async function callerContextRepos(db: DB, userId: string): Promise<RepoRow[]> {
  const result: RepoRow[] = [];
  const seen = new Set<string>();
  const add = (rows: RepoRow[]) => { for (const r of rows) if (!seen.has(r.id)) { result.push(r); seen.add(r.id); } };
  const ownedAgents = await db.select().from(agents).where(eq(agents.associatedUserId, userId));
  const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, userId));
  const ownerUserIds = [userId, ...ownedAgents.map(a => a.serviceUserId).filter((x): x is string => !!x)];
  add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "user"), inArray(repositories.namespaceId, ownerUserIds))));
  for (const m of memberships) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, m.orgId))));
  for (const a of ownedAgents) add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, a.id))));
  const grants = await db.select().from(repoCollaborators).where(eq(repoCollaborators.userId, userId));
  const grantRepoIds = grants.map(g => g.repoId).filter(id => !seen.has(id));
  if (grantRepoIds.length) add(await db.select().from(repositories).where(inArray(repositories.id, grantRepoIds)));
  return result;
}

export interface VisibleIdentity extends Identity {
  sharedRepoIds: string[];
}

const ACTIVITY_SCAN_LIMIT = 1000;

/**
 * The caller's full common-context identity set, keyed `${kind}:${id}`.
 * Sources per shared repo: the owning user, org members, collaborator
 * grants (agent + human), and recent public-activity authors.
 */
export async function visibleIdentities(db: DB, callerUserId: string): Promise<Map<string, VisibleIdentity>> {
  const repos = await callerContextRepos(db, callerUserId);
  const repoIds = repos.map(r => r.id);
  const userShared = new Map<string, Set<string>>();
  const agentShared = new Map<string, Set<string>>();
  const tag = (map: Map<string, Set<string>>, id: string | null | undefined, repoId: string | null) => {
    if (!id) return;
    let s = map.get(id);
    if (!s) { s = new Set(); map.set(id, s); }
    if (repoId) s.add(repoId);
  };

  tag(userShared, callerUserId, null);
  for (const r of repos) if (r.namespaceType === "user") tag(userShared, r.namespaceId, r.id);

  const orgIds = [...new Set(repos.filter(r => r.namespaceType === "org").map(r => r.namespaceId))];
  if (orgIds.length) {
    const members = await db.select().from(orgMembers).where(inArray(orgMembers.orgId, orgIds));
    const orgRepos = new Map<string, string[]>();
    for (const r of repos) if (r.namespaceType === "org") orgRepos.set(r.namespaceId, [...(orgRepos.get(r.namespaceId) ?? []), r.id]);
    for (const m of members) for (const rid of orgRepos.get(m.orgId) ?? []) tag(userShared, m.userId, rid);
  }

  if (repoIds.length) {
    const collabs = await db.select().from(repoCollaborators).where(inArray(repoCollaborators.repoId, repoIds));
    for (const cRow of collabs) {
      tag(agentShared, cRow.agentId, cRow.repoId);
      tag(userShared, cRow.userId, cRow.repoId);
    }
    const activity = await db.select().from(publicActivity)
      .where(inArray(publicActivity.repoId, repoIds))
      .orderBy(desc(publicActivity.createdAt))
      .limit(ACTIVITY_SCAN_LIMIT);
    for (const ev of activity) {
      tag(agentShared, ev.agentId, ev.repoId);
      tag(userShared, ev.userId, ev.repoId);
    }
  }

  // Identities the caller GOVERNS are always visible — a freshly-created
  // agent (e.g. a v4 global deployment with no grants and no activity yet)
  // must never 404 for its own governor.
  const governed = await db.select({ id: agents.id }).from(agents)
    .where(eq(agents.associatedUserId, callerUserId));
  for (const g of governed) tag(agentShared, g.id, null);

  const out = new Map<string, VisibleIdentity>();
  const userIds = [...userShared.keys()];
  if (userIds.length) {
    const rows = await db.select().from(users).where(inArray(users.id, userIds));
    for (const u of rows) {
      if (u.kind !== "human") continue; // service users are plumbing, not people
      out.set(identityKey("human", u.id), { ...userToIdentity(u), sharedRepoIds: [...(userShared.get(u.id) ?? [])] });
    }
  }
  const agentIds = [...agentShared.keys()];
  if (agentIds.length) {
    const rows = await db.select().from(agents).where(inArray(agents.id, agentIds));
    for (const a of rows) {
      if (a.archivedAt) continue;
      out.set(identityKey("agent", a.id), { ...agentToIdentity(a), sharedRepoIds: [...(agentShared.get(a.id) ?? [])] });
    }
  }
  return out;
}

/** Recent activity by one identity inside the caller's shared repos. */
export async function identityActivity(db: DB, callerUserId: string, identity: Identity, limit = 50) {
  const repos = await callerContextRepos(db, callerUserId);
  const repoIds = repos.map(r => r.id);
  if (!repoIds.length) return [];
  const actorCond = identity.kind === "human"
    ? eq(publicActivity.userId, identity.id)
    : eq(publicActivity.agentId, identity.id);
  return db.select().from(publicActivity)
    .where(and(inArray(publicActivity.repoId, repoIds), actorCond))
    .orderBy(desc(publicActivity.createdAt))
    .limit(Math.min(200, limit));
}

/** Kill switch (default on): the identity directory surface. */
export function identityDirectoryEnabled(): boolean {
  return process.env.CLAWHUB_DISABLE_IDENTITY_DIRECTORY !== "1";
}
