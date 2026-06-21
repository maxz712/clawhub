import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import { resolveNamespace } from "./repo-resolver.js";
import type { NamespaceKind } from "./namespace.js";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors.js";
import { hashToken, randomToken } from "./auth.js";
import type { ShardMap } from "./shard-map.js";
import { isLocal } from "./shard-map.js";
import type { GitClientPool } from "./git-client.js";
import { log } from "./logger.js";

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

  const inserted = (await db.insert(repositories).values({
    name: repoName,
    namespaceType: ownerKind,
    namespaceId: ownerId,
  }).returning())[0];

  // Agents never own — grant the pushing agent writer on the repo it created.
  await db.insert(repoCollaborators).values({ repoId: inserted.id, agentId, role: "writer" }).onConflictDoNothing();

  await ensureBareExists(db, git, namespace, repoName, inserted.id, opts);
  return { repoId: inserted.id, created: true };
}

/**
 * Find-or-create the service-account user that owns a headless agent's repos.
 * The username equals the agent's name so the on-disk path (`<name>/<repo>.git`)
 * and namespace resolution stay consistent. The account can never sign in (no
 * human, un-recoverable password) and is flagged `kind: "service"`.
 */
export async function ensureServiceUserForAgent(db: DB, agent: typeof agents.$inferSelect): Promise<string> {
  if (agent.serviceUserId) return agent.serviceUserId;
  const existing = (await db.select().from(users).where(eq(users.username, agent.name)).limit(1))[0];
  let userId: string;
  if (existing) {
    if (existing.kind !== "service") throw new ConflictError(`cannot provision service account: name ${agent.name} taken`);
    userId = existing.id;
  } else {
    const inserted = (await db.insert(users).values({
      // `.invalid` is a reserved TLD — can never collide with a human's email.
      email: `svc-${agent.id}@clawhub.invalid`,
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
