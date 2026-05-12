import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { resolveNamespace } from "./repo-resolver.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
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
 * Ensure a repo exists for an agent push. Creates the bare repo + DB row on first push
 * if the authenticated agent is allowed to own or write to the target namespace.
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
  const ns = await resolveNamespace(db, namespace);
  if (!ns) {
    const a = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (!a[0] || a[0].name !== namespace) throw new NotFoundError(`namespace ${namespace}`);
  }

  const existing = ns ? await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, ns.kind),
    eq(repositories.namespaceId, ns.id),
    eq(repositories.name, repoName),
  )).limit(1) : [];

  if (existing[0]) {
    await checkPushRights(db, existing[0].id, existing[0].namespaceType, existing[0].namespaceId, agentId);
    await ensureBareExists(db, git, namespace, repoName, existing[0].id, opts);
    return { repoId: existing[0].id, created: false };
  }

  // Create namespace-bound repo.
  if (ns?.kind === "org") {
    const a = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const memberOfOrg = a[0]?.associatedUserId
      ? await db.select().from(orgMembers).where(and(
          eq(orgMembers.orgId, ns.id),
          eq(orgMembers.userId, a[0].associatedUserId),
        )).limit(1)
      : [];
    if (!memberOfOrg[0]) throw new ForbiddenError("agent not authorized to create repos in this org");
  } else if (ns?.kind === "agent") {
    if (ns.id !== agentId) throw new ForbiddenError("agents can only create repos in their own namespace");
  }

  const nsId = ns?.id ?? agentId;
  const nsKind: "agent" | "org" = ns?.kind ?? "agent";

  const inserted = await db.insert(repositories).values({
    name: repoName,
    namespaceType: nsKind,
    namespaceId: nsId,
  }).returning();

  await ensureBareExists(db, git, namespace, repoName, inserted[0].id, opts);
  return { repoId: inserted[0].id, created: true };
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
        const client = opts.gitClients.get(placed);
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

async function checkPushRights(db: DB, repoId: string, nsKind: "agent" | "org", nsId: string, agentId: string): Promise<void> {
  if (nsKind === "agent" && nsId === agentId) return;
  const collab = await db.select().from(repoCollaborators).where(and(
    eq(repoCollaborators.repoId, repoId),
    eq(repoCollaborators.agentId, agentId),
  )).limit(1);
  if (collab[0] && (collab[0].role === "writer" || collab[0].role === "reviewer")) return;
  if (nsKind === "org") {
    const a = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    if (a[0]?.associatedUserId) {
      const member = await db.select().from(orgMembers).where(and(
        eq(orgMembers.orgId, nsId),
        eq(orgMembers.userId, a[0].associatedUserId),
      )).limit(1);
      if (member[0]) return;
    }
  }
  throw new ForbiddenError("agent not permitted to push to this repo");
}
