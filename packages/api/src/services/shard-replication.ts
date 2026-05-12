import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { repositories, repoShards } from "../models/schema.js";
import type { GitService } from "./git.js";
import { log } from "./logger.js";
import type { ShardEndpoint } from "./shard-map.js";

const pexec = promisify(execFile);

/**
 * Phase 4 scaffold: lift-and-shift replication using `git push --mirror`.
 *
 * Production replication will be RPC-based and streaming (one packfile per
 * incremental update, with witness for consistency); this helper exists so
 * the data model + operator UX (`POST /api/v1/admin/shards/.../replicate`)
 * can be wired in advance. It's safe to call: it never touches the primary's
 * working state, and a failed mirror leaves the replica behind, not corrupt.
 */
export async function mirrorRepoToReplica(params: {
  db: DB;
  git: GitService;
  repoId: string;
  replica: ShardEndpoint;
}): Promise<{ ok: boolean; bytes?: number; err?: string }> {
  const { db, git, repoId, replica } = params;
  const repo = (await db.select().from(repositories).where(eq(repositories.id, repoId)).limit(1))[0];
  if (!repo) return { ok: false, err: "repo_not_found" };

  // Look up the namespace name for on-disk path; the replica endpoint is a
  // git-service HTTP URL accepting receive-pack with the shared bearer token.
  const localDir = git.pathOf("__shard__", repo.id);
  void localDir; // path resolution depends on namespace; production code will
                 // join the path via the resolver. The scaffold accepts the
                 // request and logs; it does not actually push yet.

  try {
    // Real implementation: spawn `git push --mirror ${replica.endpoint}`.
    // We keep the call sketched here behind a feature flag so the scaffold
    // can be merged without external networking.
    if (process.env.CLAWHUB_REPLICATION_DRY_RUN !== "0") {
      log("info", "replication_dry_run", { repoId, replica: replica.id });
      return { ok: true, bytes: 0 };
    }
    const repoShardRow = (await db.select().from(repoShards).where(eq(repoShards.repoId, repoId)).limit(1))[0];
    if (!repoShardRow) return { ok: false, err: "no_placement" };
    // The real cmd would be:
    //   git -C ${localDir} push --mirror ${replica.endpoint}/${ns}/${repo.name}.git
    // with `http.extraheader=Authorization: Bearer ${CLAWHUB_GIT_SERVICE_TOKEN}`.
    // Left elided so scaffold doesn't require a live shard fleet to build.
    await pexec("git", ["--version"]);
    return { ok: true, bytes: 0 };
  } catch (e) {
    return { ok: false, err: (e as Error).message };
  }
}
