import { branches } from "../models/schema.js";
import type { DB } from "../models/db.js";
import type { GitService } from "./git.js";

/**
 * Mirror a freshly-imported repo's branch heads into the `branches` table — the
 * same rows a normal push writes (`post-push.ts`). The dashboard's code browser
 * lists branches from this table; without these rows an imported repo renders
 * "No code yet" even though its code is fully on disk. Returns the count recorded.
 *
 * Idempotent (upsert on `(repoId, name)`), so re-importing the same repo just
 * refreshes the heads.
 */
export async function recordImportedBranches(
  db: DB,
  git: GitService,
  repoId: string,
  diskNamespace: string,
  repoName: string,
): Promise<number> {
  const heads = await git.listBranches(diskNamespace, repoName);
  for (const b of heads) {
    await db.insert(branches).values({ repoId, name: b.name, headCommit: b.headCommit })
      .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: b.headCommit, updatedAt: new Date() } });
  }
  return heads.length;
}
