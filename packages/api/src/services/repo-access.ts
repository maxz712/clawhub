import { and, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import type { TokenPayload } from "./auth.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import { mustResolveRepo, resolveRepo } from "./repo-resolver.js";

// Repo authorization. ClawHub authenticates every API caller (authMiddleware) but
// historically did NOT authorize them against the target repo — any valid token
// (including a freshly self-registered agent) could read or mutate any repo,
// public or private. This module is the single place that answers "what may THIS
// caller do to THIS repo", so routes stop trusting "has a token" as "has access".
//
// Levels (monotonic): none < read < review < write < admin.
//   read   — see the repo + its changes/issues/code/comments/CI/secret-names.
//   review — read PLUS submit reviews (verdicts/comments) on changes. The
//            `reviewer` collaborator role lands here: it is strictly LOWER than
//            write — a reviewer agent may NOT push, merge, rollback, manage
//            secrets/webhooks/CI/policy, or mutate repo settings.
//   write  — push/merge/rollback, manage secrets/webhooks/CI/policy.
//   admin  — repo owner / org admin (settings, transfer, delete, collaborators).
//
// Membership model (mirrors auto-repo.ts checkPushRights, extended to users +
// reads): repos are owned by a USER or ORG namespace; agents are GRANTED via
// repo_collaborators (agent-only rows, role writer|reviewer). A `writer` grant
// is full write; a `reviewer` grant is read+review only (cannot push — see
// auto-repo.ts checkPushRights). A human reaches a repo as the owning user, an
// org member, or through an agent they own (associated or service user). Public
// repos are readable by any authenticated caller; private repos require
// membership.
export type RepoAccessLevel = "none" | "read" | "review" | "write" | "admin";

const RANK: Record<RepoAccessLevel, number> = { none: 0, read: 1, review: 2, write: 3, admin: 4 };

// Map a repo_collaborators.role onto an access level. A writer grant is full
// write; a reviewer grant is the strictly-lower read+review level.
function levelForCollabRole(role: string): RepoAccessLevel {
  return role === "reviewer" ? "review" : "write";
}

type RepoRow = typeof repositories.$inferSelect;

/**
 * Compute the caller's access level to a repo. Never throws on "no access" —
 * returns "none". A `null` caller is an ANONYMOUS (no-token) request: it may
 * read PUBLIC repos only, so the public browse surface can serve logged-out
 * visitors without ever exposing a private repo's existence.
 */
export async function repoAccessFor(db: DB, repo: RepoRow, caller: TokenPayload | null): Promise<RepoAccessLevel> {
  // Anonymous caller: a public repo is read-only; everything else is invisible.
  if (!caller) return repo.isPublic ? "read" : "none";
  if (caller.kind === "user") {
    const uid = caller.userId;
    // Direct owner of a user namespace.
    if (repo.namespaceType === "user" && repo.namespaceId === uid) return "admin";
    // Org member — admins get admin, members get write.
    if (repo.namespaceType === "org") {
      const m = (await db.select().from(orgMembers)
        .where(and(eq(orgMembers.orgId, repo.namespaceId), eq(orgMembers.userId, uid))).limit(1))[0];
      if (m) return m.role === "admin" ? "admin" : "write";
    }
    // Through an agent the human owns (claimed = associatedUserId, or its service user).
    const owned = await db.select({ id: agents.id }).from(agents)
      .where(or(eq(agents.associatedUserId, uid), eq(agents.serviceUserId, uid)));
    const ids = owned.map(a => a.id);
    // The user reaches this repo by the BEST grant across: agents they own that
    // are collaborators, AND a direct HUMAN collaborator grant on the repo (one
    // person granted access to one repo with no org membership). Best-of so a
    // weaker grant of one kind can't mask a stronger grant of the other.
    let best: RepoAccessLevel = "none";
    if (ids.length) {
      if (repo.namespaceType === "agent" && ids.includes(repo.namespaceId)) return "admin"; // legacy agent-owned
      const collabs = (await db.select().from(repoCollaborators)
        .where(and(eq(repoCollaborators.repoId, repo.id), inArray(repoCollaborators.agentId, ids))));
      for (const c of collabs) {
        const lvl = levelForCollabRole(c.role);
        if (RANK[lvl] > RANK[best]) best = lvl;
      }
    }
    const humanGrant = (await db.select().from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, uid))).limit(1))[0];
    if (humanGrant) {
      const lvl = levelForCollabRole(humanGrant.role);
      if (RANK[lvl] > RANK[best]) best = lvl;
    }
    if (best !== "none") return best;
    return repo.isPublic ? "read" : "none";
  }

  // Agent caller.
  const aid = caller.agentId;
  // Legacy agent-owned repo: the owning agent gets WRITE, not admin. Admin would
  // let the agent self-govern (PATCH mergePolicy/branch protection/collaborators)
  // and disable human supervision on its own repo. The governing HUMAN still
  // reaches admin via the user-caller branch above ("agents never own").
  if (repo.namespaceType === "agent" && repo.namespaceId === aid) return "write";
  const collab = (await db.select().from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, aid))).limit(1))[0];
  // writer → write; reviewer → read+review only (reviewer cannot push — see
  // auto-repo.ts checkPushRights — nor reach any resolveRepoForWrite route).
  if (collab) return levelForCollabRole(collab.role);
  const a = (await db.select().from(agents).where(eq(agents.id, aid)).limit(1))[0];
  if (a) {
    if (repo.namespaceType === "user" && (a.associatedUserId === repo.namespaceId || a.serviceUserId === repo.namespaceId)) return "write";
    if (repo.namespaceType === "org" && a.associatedUserId) {
      const m = (await db.select().from(orgMembers)
        .where(and(eq(orgMembers.orgId, repo.namespaceId), eq(orgMembers.userId, a.associatedUserId))).limit(1))[0];
      if (m) return m.role === "admin" ? "admin" : "write";
    }
  }
  return repo.isPublic ? "read" : "none";
}

// A denied READ throws 404 (not 403) so we never leak whether a private repo
// exists. A denied write/admin on a repo the caller CAN read throws 403.
export async function requireRepoRead(db: DB, repo: RepoRow, caller: TokenPayload): Promise<RepoAccessLevel> {
  const lvl = await repoAccessFor(db, repo, caller);
  if (RANK[lvl] < RANK.read) throw new NotFoundError(`repo ${repo.name}`);
  return lvl;
}
// Review gate: read PLUS the ability to submit reviews. Satisfied by the
// `reviewer` collaborator role (level `review`) and by anyone with write/admin.
// Use this for review submission so a reviewer-role agent is admitted WITHOUT
// granting it the broader `write` surface (push/merge/secrets/CI).
export async function requireRepoReview(db: DB, repo: RepoRow, caller: TokenPayload): Promise<RepoAccessLevel> {
  const lvl = await repoAccessFor(db, repo, caller);
  if (RANK[lvl] < RANK.read) throw new NotFoundError(`repo ${repo.name}`);
  if (RANK[lvl] < RANK.review) throw new ForbiddenError("review access to this repo is required");
  return lvl;
}
export async function requireRepoWrite(db: DB, repo: RepoRow, caller: TokenPayload): Promise<RepoAccessLevel> {
  const lvl = await repoAccessFor(db, repo, caller);
  if (RANK[lvl] < RANK.read) throw new NotFoundError(`repo ${repo.name}`);
  if (RANK[lvl] < RANK.write) throw new ForbiddenError("write access to this repo is required");
  return lvl;
}
export async function requireRepoAdmin(db: DB, repo: RepoRow, caller: TokenPayload): Promise<RepoAccessLevel> {
  const lvl = await repoAccessFor(db, repo, caller);
  if (RANK[lvl] < RANK.read) throw new NotFoundError(`repo ${repo.name}`);
  if (RANK[lvl] < RANK.admin) throw new ForbiddenError("admin access to this repo is required");
  return lvl;
}

// Resolve + authorize in one call — the drop-in for route handlers that today do
// `const { repo } = await mustResolveRepo(db, ns, name)`. Returns the same
// { namespace, repo } shape plus the caller's access level.
export async function resolveRepoForRead(db: DB, ns: string, name: string, caller: TokenPayload) {
  const r = await mustResolveRepo(db, ns, name);
  const access = await requireRepoRead(db, r.repo, caller);
  return { ...r, access };
}
export async function resolveRepoForReview(db: DB, ns: string, name: string, caller: TokenPayload) {
  const r = await mustResolveRepo(db, ns, name);
  const access = await requireRepoReview(db, r.repo, caller);
  return { ...r, access };
}
export async function resolveRepoForWrite(db: DB, ns: string, name: string, caller: TokenPayload) {
  const r = await mustResolveRepo(db, ns, name);
  const access = await requireRepoWrite(db, r.repo, caller);
  return { ...r, access };
}
export async function resolveRepoForAdmin(db: DB, ns: string, name: string, caller: TokenPayload) {
  const r = await mustResolveRepo(db, ns, name);
  const access = await requireRepoAdmin(db, r.repo, caller);
  return { ...r, access };
}

// Public browse surface: resolve + authorize a possibly-ANONYMOUS read. `caller`
// is null for a no-token request; a public repo is readable, a private one (or a
// missing namespace/repo) throws 404 so anonymous callers can never tell a
// private repo apart from a non-existent one (no existence leak). An
// authenticated caller passing through here still gets their real access level,
// so a logged-in member following a public link into their OWN private repo is
// not bounced — repoAccessFor decides.
export async function resolveRepoForPublicRead(db: DB, ns: string, name: string, caller: TokenPayload | null) {
  const r = await resolveRepo(db, ns, name);
  if (!r) throw new NotFoundError(`repo ${ns}/${name}`);
  const access = await repoAccessFor(db, r.repo, caller);
  if (RANK[access] < RANK.read) throw new NotFoundError(`repo ${ns}/${name}`);
  return { ...r, access };
}

// Read-gate by repo id (not name) — for callers that already hold a repoId, e.g.
// filtering an event fan-out. Returns true for a missing/absent repoId (non-repo
// event) so global events still flow; false when the caller can't read the repo.
export async function canReadRepoId(db: DB, repoId: string | null | undefined, caller: TokenPayload): Promise<boolean> {
  if (!repoId) return true;
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!repo) return true; // can't resolve — no private data to protect
  return (await repoAccessFor(db, repo, caller)) !== "none";
}
