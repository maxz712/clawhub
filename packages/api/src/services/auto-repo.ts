import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import { resolveNamespace } from "./repo-resolver.js";
import type { NamespaceKind } from "./namespace.js";
// namespace.ts imports ensureServiceUserForAgent from here, so this is a cycle.
// It is safe: neither module touches the other at MODULE-INIT time (the reserved
// set is a plain const, read only from inside a function at request time).
import { isPlatformNamespace } from "./namespace.js";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.js";
import { agentAccessConstraint, constraintCoversRepo, constraintHas } from "./access-roles.js";
import { hashToken, randomToken } from "./auth.js";
import type { ShardMap } from "./shard-map.js";
import { isLocal } from "./shard-map.js";
import type { GitClientPool } from "./git-client.js";
import { log } from "./logger.js";
import { getOrgMergePolicy } from "./org-policy.js";
import { repoAccessFor } from "./repo-access.js";

export interface AutoRepoOpts {
  /** When set, the repo is placed via {@link ShardMap.placeNew} on first creation. */
  shardMap?: ShardMap;
  /** When set with `shardMap`, the bare repo is initialized on the chosen shard via gRPC. */
  gitClients?: GitClientPool;
}

/**
 * Ensure a repo exists for an agent push. Creates the bare repo + DB row on first
 * push if the authenticated agent is allowed to write to the target namespace.
 *
 * Ownership invariant: **agents never own repos.** A repo is owned by a USER
 * (human or service-account) or an ORG; the pushing agent is granted `writer`
 * via {@link repoCollaborators}. A headless agent pushing to its own bare name
 * gets a same-named service-account user provisioned to own its repos.
 *
 * When a `ShardMap` is provided, new repos are placed via rendezvous (HRW) hashing
 * onto a healthy `git-service` shard and the bare repo is initialized there. Repos
 * placed on `local://inprocess` (no shards configured) fall back to the legacy
 * filesystem-backed flow.
 */
export async function ensureRepoForAgentPush(
  db: DB,
  git: GitService,
  namespace: string,
  repoName: string,
  agentId: string,
  opts: AutoRepoOpts = {},
): Promise<{ repoId: string; created: boolean }> {
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (!agent) throw new NotFoundError(`agent ${agentId}`);

  const ns = await resolveNamespace(db, namespace);
  // An unresolvable name is only valid when it's the pushing agent's own name —
  // a headless first push, where we'll provision a service-account owner below.
  // (resolveNamespace normally returns the agent row for that case, so `ns` is
  // rarely null; this is a defensive guard.)
  if (!ns && agent.name !== namespace) throw new NotFoundError(`namespace ${namespace}`);

  if (ns) {
    const existing = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, ns.kind),
      eq(repositories.namespaceId, ns.id),
      eq(repositories.name, repoName),
    )).limit(1))[0];
    if (existing) {
      await checkPushRights(db, existing.id, existing.namespaceType, existing.namespaceId, agentId);
      await ensureBareExists(db, git, namespace, repoName, existing.id, opts);
      return { repoId: existing.id, created: false };
    }
  }

  // Creating a new repo. Resolve the OWNER namespace — never an agent.
  let ownerKind: "user" | "org";
  let ownerId: string;
  if (ns?.kind === "org") {
    const memberOfOrg = agent.associatedUserId
      ? (await db.select().from(orgMembers).where(and(
          eq(orgMembers.orgId, ns.id),
          eq(orgMembers.userId, agent.associatedUserId),
        )).limit(1))[0]
      : undefined;
    if (!memberOfOrg) throw new ForbiddenError("agent not authorized to create repos in this org");
    // RBAC: creating a repo under the company namespace is an ADMIN action — a
    // plain member could otherwise spin up repos in the org. Members still push
    // to / collaborate on existing org repos; only admins create new ones.
    if (memberOfOrg.role !== "admin") {
      throw new ForbiddenError("only an org admin can create a repo in this org namespace", "org_admin_required");
    }
    ownerKind = "org"; ownerId = ns.id;
  } else if (ns?.kind === "user") {
    // The agent must be claimed by that user, or this must be its own service user.
    if (agent.associatedUserId !== ns.id && agent.serviceUserId !== ns.id) {
      throw new ForbiddenError("agent not authorized to create repos in this namespace");
    }
    ownerKind = "user"; ownerId = ns.id;
  } else {
    // `ns` is null or an `agent` namespace == the pushing agent's own name.
    // Provision (or reuse) the agent's same-named service-account user to own it.
    if (ns && ns.id !== agentId) throw new ForbiddenError("agents can only create repos in their own namespace");
    ownerKind = "user"; ownerId = await ensureServiceUserForAgent(db, agent);
  }

  // New ORG repos inherit the org's default merge policy if one is set (the
  // system default otherwise). A per-repo policy / in-repo merge.yml override later.
  const orgDefaultPolicy = ownerKind === "org" ? await getOrgMergePolicy(db, ownerId) : null;

  const inserted = (await db.insert(repositories).values({
    name: repoName,
    namespaceType: ownerKind,
    namespaceId: ownerId,
    ...(orgDefaultPolicy ? { mergePolicy: orgDefaultPolicy } : {}),
  }).returning())[0];

  // Agents never own — grant the pushing agent writer on the repo it created.
  await db.insert(repoCollaborators).values({ repoId: inserted.id, agentId, role: "writer" }).onConflictDoNothing();

  await ensureBareExists(db, git, namespace, repoName, inserted.id, opts);
  return { repoId: inserted.id, created: true };
}

/**
 * Ensure a repo exists for a HUMAN push. The first-class-human-push analogue of
 * {@link ensureRepoForAgentPush}: a logged-in human pushes their own code with a
 * user token. Creates the bare repo + DB row on first push if the user owns the
 * target namespace (their own handle) or is an org admin; otherwise requires an
 * existing repo the user has WRITE access to (owner, org member, or human
 * collaborator — decided by {@link repoAccessFor}, the single authz authority).
 *
 * Unlike the agent path there is no service-account indirection and no collaborator
 * grant to mint: a human IS a first-class namespace owner.
 */
export async function ensureRepoForUserPush(
  db: DB,
  git: GitService,
  namespace: string,
  repoName: string,
  userId: string,
  opts: AutoRepoOpts = {},
): Promise<{ repoId: string; created: boolean }> {
  const user = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
  if (!user) throw new NotFoundError(`user ${userId}`);

  const ns = await resolveNamespace(db, namespace);
  if (ns) {
    const existing = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, ns.kind),
      eq(repositories.namespaceId, ns.id),
      eq(repositories.name, repoName),
    )).limit(1))[0];
    if (existing) {
      const level = await repoAccessFor(db, existing, { kind: "user", userId, email: user.email });
      if (level !== "write" && level !== "admin") {
        throw new ForbiddenError("you do not have push access to this repo");
      }
      await ensureBareExists(db, git, namespace, repoName, existing.id, opts);
      return { repoId: existing.id, created: false };
    }
  }

  // Creating a new repo. The owner is the human's own user namespace or an org
  // they administer — never the agent path's service account.
  let ownerKind: "user" | "org";
  let ownerId: string;
  if (ns?.kind === "org") {
    const member = (await db.select().from(orgMembers).where(and(
      eq(orgMembers.orgId, ns.id),
      eq(orgMembers.userId, userId),
    )).limit(1))[0];
    if (!member) throw new ForbiddenError("you are not a member of this org");
    if (member.role !== "admin") {
      throw new ForbiddenError("only an org admin can create a repo in this org namespace", "org_admin_required");
    }
    ownerKind = "org"; ownerId = ns.id;
  } else if (ns?.kind === "user") {
    if (ns.id !== userId) throw new ForbiddenError("you can only create repos in your own namespace");
    ownerKind = "user"; ownerId = userId;
  } else {
    // Namespace doesn't resolve. The only namespace a human may auto-create under
    // is their own handle; a brand-new handle should be the user's username.
    if (user.username && user.username === namespace) {
      ownerKind = "user"; ownerId = userId;
    } else {
      throw new NotFoundError(`namespace ${namespace}`);
    }
  }

  const orgDefaultPolicy = ownerKind === "org" ? await getOrgMergePolicy(db, ownerId) : null;

  const inserted = (await db.insert(repositories).values({
    name: repoName,
    namespaceType: ownerKind,
    namespaceId: ownerId,
    ...(orgDefaultPolicy ? { mergePolicy: orgDefaultPolicy } : {}),
  }).returning())[0];

  await ensureBareExists(db, git, namespace, repoName, inserted.id, opts);
  return { repoId: inserted.id, created: true };
}

/**
 * The email a service-account user provisioned FOR a given agent carries. It is
 * the only durable proof of which agent a `kind: "service"` user belongs to —
 * `users.username` is just the agent's name, and a name is not an identity.
 * `.invalid` is a reserved TLD, so this can never collide with a human's email.
 */
export function serviceUserEmail(agentId: string): string {
  return `svc-${agentId}@clawhub.invalid`;
}

/**
 * Find-or-create the service-account user that owns a headless agent's repos.
 * The username equals the agent's name so the on-disk path (`<name>/<repo>.git`)
 * and namespace resolution stay consistent. The account can never sign in (no
 * human, un-recoverable password) and is flagged `kind: "service"`.
 *
 * #139: this used to ADOPT any pre-existing `kind: "service"` row whose username
 * matched, with no check that the row was ever provisioned for THIS agent. Since
 * ClawHub's own platform namespaces (`gh-mirror`, `clawhub-system`) are exactly
 * that shape, an agent minted on one of those names — reachable from any public
 * repo via `forkRepo`, and from `resolveImportOwner` — took over the namespace
 * and, via `repo-access.ts`, gained `write` on every mirrored private PR. The old
 * `kind !== "service"` guard blocked stealing a HUMAN's handle, which is the
 * wrong half: every namespace worth stealing here is a service account.
 *
 * So an existing row is adopted only when it is PROVABLY this agent's own — its
 * email is `svc-<this agent id>@clawhub.invalid`, which only this function ever
 * writes. Agents provisioned before this change are unaffected: provisioning has
 * always set `agents.service_user_id`, and that back-pointer short-circuits above.
 */
export async function ensureServiceUserForAgent(db: DB, agent: typeof agents.$inferSelect): Promise<string> {
  if (agent.serviceUserId) return agent.serviceUserId;
  // Belt-and-braces with the create-time guard: an agent row that predates the
  // reserved list (or was written directly to the DB) still cannot MINT a
  // platform namespace pre-emptively (the email pin below only stops it
  // ADOPTING one that already exists). Narrowed to `isPlatformNamespace`, not
  // the whole reserved list, because this runs against rows that already exist
  // — a legacy agent named `admin` must keep pushing. ClawHub's own system
  // agents are exempt: they ARE those identities.
  if (!agent.isSystem && isPlatformNamespace(agent.name)) {
    throw new ConflictError(`cannot provision service account: "${agent.name}" is reserved by ClawHub`);
  }
  const existing = (await db.select().from(users).where(eq(users.username, agent.name)).limit(1))[0];
  let userId: string;
  if (existing) {
    if (existing.kind !== "service" || existing.email !== serviceUserEmail(agent.id)) {
      throw new ConflictError(`cannot provision service account: name ${agent.name} taken`);
    }
    userId = existing.id;
  } else {
    const inserted = (await db.insert(users).values({
      // The agent-id-keyed email is what makes the adoption check above provable.
      email: serviceUserEmail(agent.id),
      username: agent.name,
      name: agent.name,
      kind: "service",
      passwordHash: await hashToken(randomToken(24)),
    }).returning())[0];
    userId = inserted.id;
  }
  await db.update(agents).set({ serviceUserId: userId }).where(eq(agents.id, agent.id));
  return userId;
}

async function ensureBareExists(
  db: DB,
  git: GitService,
  namespace: string,
  repoName: string,
  repoId: string,
  opts: AutoRepoOpts,
): Promise<void> {
  if (opts.shardMap && opts.gitClients) {
    const placed = await opts.shardMap.placeNew(repoId);
    if (!isLocal(placed)) {
      try {
        const client = opts.gitClients.rpc(placed);
        await client.initBare({ namespace, name: repoName });
        log("info", "repo_placed_on_shard", { repoId, shard: placed.id });
        return;
      } catch (e) {
        // Shard unreachable on placement — fall through to local init so the
        // push still succeeds; an operator can run a migration to move it later.
        log("warn", "shard_init_failed_fallback_local", { err: (e as Error).message, repoId });
      }
    }
  }
  if (!(await git.exists(namespace, repoName))) await git.initBare(namespace, repoName);
}

/**
 * Whether `agentId` may push to an existing repo. The universal path is an
 * explicit {@link repoCollaborators} grant with the `writer` role (every
 * repo-creating agent gets one). A `reviewer` grant is read+review ONLY — it
 * does NOT confer push (mirrors services/repo-access.ts, where `reviewer`
 * resolves to the `review` level, strictly below `write`). A legacy agent-owned
 * repo still admits its owner agent (transitional). A user-owned repo also
 * admits the owning user's claimed agent or its service account; an org-owned
 * repo admits the agent's human org members.
 */
async function checkPushRights(db: DB, repoId: string, nsKind: NamespaceKind, nsId: string, agentId: string): Promise<void> {
  // Access roles are a CEILING over every grant path below: an agent holding
  // a role may only push where the role's scope covers the repo and only if
  // the role grants repo:write at all (v3 RBAC, docs/redesign-v3.md §2).
  const constraint = await agentAccessConstraint(db, agentId);
  if (constraint) {
    if (!constraintHas(constraint, "repo:write")) throw new ForbiddenError("this agent's role does not permit pushing code");
    if (!constraintCoversRepo(constraint, repoId)) throw new ForbiddenError("this repo is outside the agent's role scope");
  }
  // Transitional: legacy agent-owned repo, pushing agent is the owner.
  if (nsKind === "agent" && nsId === agentId) return;
  const collab = (await db.select().from(repoCollaborators).where(and(
    eq(repoCollaborators.repoId, repoId),
    eq(repoCollaborators.agentId, agentId),
  )).limit(1))[0];
  // Only a `writer` grant confers push. A `reviewer` grant must NOT — admitting
  // it here was a privilege escalation (a review-only agent could push code).
  if (collab && collab.role === "writer") return;
  const a = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0];
  if (nsKind === "user" && a && (a.associatedUserId === nsId || a.serviceUserId === nsId)) return;
  if (nsKind === "org" && a?.associatedUserId) {
    const member = (await db.select().from(orgMembers).where(and(
      eq(orgMembers.orgId, nsId),
      eq(orgMembers.userId, a.associatedUserId),
    )).limit(1))[0];
    if (member) return;
  }
  throw new ForbiddenError("agent not permitted to push to this repo");
}
