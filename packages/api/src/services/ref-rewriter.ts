import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { branches, changes, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { withChangeUpsertLock } from "./repo-lock.js";
import { resolveNamespace } from "./repo-resolver.js";
import type { PushActor } from "./push-queue.js";

const pexec = promisify(execFile);

export interface MagicRefIntake {
  ref: string;          // input ref the client pushed to (refs/for/<branch>)
  newSha: string;       // commit pushed
  targetBranch: string; // branch the change targets (parsed from ref)
}

const MAGIC_PREFIXES = ["refs/for/", "refs/clawhub/for/"] as const;

/**
 * Parse a magic ref (refs/for/<branch>) into its target branch. Returns null
 * if the ref is a direct push ref (refs/heads/<branch>).
 */
export function parseMagicRef(ref: string): { target: string } | null {
  for (const p of MAGIC_PREFIXES) {
    if (ref.startsWith(p)) {
      const target = ref.slice(p.length);
      if (!target) return null;
      return { target };
    }
  }
  return null;
}

/**
 * Server-side rewrite for refs/for/<branch> pushes: allocate a Change ID,
 * write the commits to refs/clawhub/changes/<id>, and never advance
 * refs/heads/<branch> directly. The agent only sees their commit landed under
 * a server-allocated ref — branch contention is gone.
 *
 * This is invoked by the post-receive hook (`scripts/git-hooks/post-receive`)
 * which posts the magic-ref entries to the API. We keep the logic here so the
 * intake path is the same regardless of which transport (HTTP, hook, gRPC)
 * delivers the event.
 */
export async function admitMagicRefs(params: {
  db: DB;
  git: GitService;
  namespace: string;
  repoName: string;
  actor: PushActor;
  refs: MagicRefIntake[];
}): Promise<Array<{ changeId: string; ref: string }>> {
  const { db, git, namespace, repoName, actor, refs } = params;
  if (!refs.length) return [];

  // SECURITY: scope the lookup to the namespace — repositories.name is not globally
  // unique, so a name-only match could resolve a magic-ref push to another tenant's repo.
  const ns = await resolveNamespace(db, namespace);
  if (!ns) return [];
  const repoRow = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, ns.kind),
    eq(repositories.namespaceId, ns.id),
    eq(repositories.name, repoName),
  )).limit(1))[0];
  if (!repoRow) return [];

  const dir = git.pathOf(namespace, repoName);
  const out: Array<{ changeId: string; ref: string }> = [];

  for (const r of refs) {
    const targetBranch = r.targetBranch;
    const allocated = await withChangeUpsertLock(db, repoRow.id, `magic:${targetBranch}`, async tx => {
      // We key Change by (repoId, branch=`magic/<target>/<head8>`) to keep the
      // existing unique constraint usable while allowing many in-flight Changes
      // against the same target.
      const synthBranch = `magic/${targetBranch}/${r.newSha.slice(0, 12)}`;
      const existing = await tx.select().from(changes).where(and(eq(changes.repoId, repoRow.id), eq(changes.branch, synthBranch))).limit(1);
      if (existing[0]) {
        return { changeId: existing[0].id, synthBranch };
      }
      const ins = await tx.insert(changes).values({
        repoId: repoRow.id,
        branch: synthBranch,
        headCommit: r.newSha,
        intent: `magic push to ${targetBranch}`,
        risk: "low",
        scope: [],
        reviewFocus: [],
        trailers: {},
        hasConflicts: false,
        openedByAgentId: actor.kind === "agent" ? actor.agentId : null,
        openedByUserId: actor.kind === "user" ? actor.userId : null,
      }).returning();

      // Mirror the branches row so post-push pipeline sees this push.
      await tx.insert(branches).values({ repoId: repoRow.id, name: synthBranch, headCommit: r.newSha })
        .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: r.newSha, updatedAt: new Date() } });

      // Agent stats are agent-only; human-authored Changes don't feed them.
      if (actor.kind === "agent") {
        await tx.execute(sql`update agents set stats = jsonb_set(coalesce(stats, '{}'::jsonb), '{changesOpened}', to_jsonb(coalesce((stats->>'changesOpened')::int, 0) + 1)) where id = ${actor.agentId}`);
      }
      return { changeId: ins[0].id, synthBranch };
    });

    // Write the unique per-change ref. Ignore failures: the post-push pipeline
    // re-runs `change-refs.set` from the existing flow as a safety net.
    try {
      await pexec("git", ["-C", dir, "update-ref", `refs/clawhub/changes/${allocated.changeId}`, r.newSha]);
    } catch { /* hook will retry */ }

    out.push({ changeId: allocated.changeId, ref: `refs/clawhub/changes/${allocated.changeId}` });
  }
  return out;
}
