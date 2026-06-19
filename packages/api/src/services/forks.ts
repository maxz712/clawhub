import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, crossRepoProposals, repositories } from "../models/schema.js";
import type { GitService } from "./git.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { namespaceNameOf } from "./namespace.js";

/**
 * Create a fork of `sourceRepoId` under the given agent namespace.
 * The on-disk repo is cloned (mirror) from the source bare repo.
 */
export async function forkRepo(db: DB, git: GitService, sourceRepoId: string, newOwnerAgentId: string, newName?: string): Promise<{ repoId: string; name: string }> {
  const src = (await db.select().from(repositories).where(eq(repositories.id, sourceRepoId)).limit(1))[0];
  if (!src) throw new NotFoundError("repo");

  const owner = (await db.select().from(agents).where(eq(agents.id, newOwnerAgentId)).limit(1))[0];
  if (!owner) throw new NotFoundError("agent");

  const name = newName ?? src.name;
  const existing = (await db.select().from(repositories).where(
    and(
      eq(repositories.namespaceType, "agent"),
      eq(repositories.namespaceId, newOwnerAgentId),
      eq(repositories.name, name),
    )
  ).limit(1))[0];
  if (existing) throw new ConflictError("repo already exists for this owner");

  const srcNs = await namespaceNameOf(db, src.namespaceType, src.namespaceId);
  if (!srcNs) throw new NotFoundError("source namespace");

  // Clone source bare repo (mirror) into target path.
  const srcPath = git.pathOf(srcNs, src.name);
  const destPath = git.pathOf(owner.name, name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(destPath, { recursive: true });
  const simpleGit = (await import("simple-git")).default;
  await simpleGit().clone(srcPath, destPath, ["--mirror"]);

  const [row] = await db.insert(repositories).values({
    name,
    namespaceType: "agent",
    namespaceId: newOwnerAgentId,
    description: src.description,
    defaultBranch: src.defaultBranch,
    isPublic: src.isPublic,
    forkOfRepoId: src.id,
    topics: src.topics,
    language: src.language,
  }).returning();

  // Materialize branches rows from on-disk refs.
  try {
    const g = simpleGit(destPath);
    const raw = await g.raw(["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/"]);
    for (const line of raw.split("\n").filter(Boolean)) {
      const [branchName, sha] = line.trim().split(/\s+/);
      await db.insert(branches).values({ repoId: row.id, name: branchName, headCommit: sha }).onConflictDoNothing();
    }
  } catch { /* best-effort */ }

  return { repoId: row.id, name };
}

export async function createCrossRepoProposal(db: DB, changeId: string, targetRepoId: string, targetBranch: string): Promise<void> {
  const ch = (await db.select().from(changes).where(eq(changes.id, changeId)).limit(1))[0];
  if (!ch) throw new NotFoundError("change");
  const target = (await db.select().from(repositories).where(eq(repositories.id, targetRepoId)).limit(1))[0];
  if (!target) throw new NotFoundError("target repo");
  if (!target.isPublic) {
    // Only allow cross-repo proposals into the upstream the source was forked from.
    const src = (await db.select().from(repositories).where(eq(repositories.id, ch.repoId)).limit(1))[0];
    if (!src || src.forkOfRepoId !== target.id) {
      throw new ValidationError("target_repo_not_upstream");
    }
  }
  await db.insert(crossRepoProposals).values({
    changeId,
    targetRepoId,
    targetBranch,
  }).onConflictDoNothing();
}
