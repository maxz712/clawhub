import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, changes, ciPipelines, ciRuns, crossRepoProposals, repoCollaborators, repositories, users } from "../models/schema.js";
import type { GitService } from "./git.js";
import type { EventBus } from "./events.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { assertSafeRepoName, namespaceNameOf } from "./namespace.js";
import { ensureServiceUserForAgent } from "./auto-repo.js";
import { withRepoLock } from "./repo-lock.js";
import { ciSchedulingStamp } from "./job-scheduling.js";
import { randomToken } from "./auth.js";

/**
 * Create a fork of `sourceRepoId` under the given agent namespace.
 * The on-disk repo is cloned (mirror) from the source bare repo.
 */
export async function forkRepo(db: DB, git: GitService, sourceRepoId: string, newOwnerAgentId: string, newName?: string): Promise<{ repoId: string; name: string }> {
  const src = (await db.select().from(repositories).where(eq(repositories.id, sourceRepoId)).limit(1))[0];
  if (!src) throw new NotFoundError("repo");

  const owner = (await db.select().from(agents).where(eq(agents.id, newOwnerAgentId)).limit(1))[0];
  if (!owner) throw new NotFoundError("agent");
  // Agents never own — the fork lives in the agent's same-named service-account
  // USER namespace; the forking agent is granted writer below.
  const ownerUserId = await ensureServiceUserForAgent(db, owner);

  // #138: `newName` is a raw request field that becomes an on-disk path segment.
  // Fork clones BEFORE it inserts, so an unvalidated `../../../../tmp/pwn` was a
  // WRITE primitive — `mkdir -p` + a `--mirror` clone outside GIT_REPOS_BASE_PATH
  // as the API user. The fallback `src.name` is an existing row, not caller
  // input, and is deliberately left alone (a legacy import may hold a name that
  // is safe on disk but not `isSafePathSegment`-clean); `git.pathOf` is the
  // containment backstop for it.
  const name = newName == null ? src.name : assertSafeRepoName(newName, "name");
  const existing = (await db.select().from(repositories).where(
    and(
      eq(repositories.namespaceType, "user"),
      eq(repositories.namespaceId, ownerUserId),
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
    namespaceType: "user",
    namespaceId: ownerUserId,
    description: src.description,
    defaultBranch: src.defaultBranch,
    isPublic: src.isPublic,
    forkOfRepoId: src.id,
    topics: src.topics,
    language: src.language,
  }).returning();
  // Grant the forking agent push/review on its fork (agents act via grants now).
  await db.insert(repoCollaborators).values({ repoId: row.id, agentId: newOwnerAgentId, role: "writer" }).onConflictDoNothing();

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

/**
 * Fork `sourceRepoId` into a HUMAN's own user namespace. The first-class-human
 * analogue of {@link forkRepo}: the fork is owned directly by the user (no
 * service-account indirection, no collaborator grant — they're the owner).
 */
export async function forkRepoForUser(db: DB, git: GitService, sourceRepoId: string, ownerUserId: string, newName?: string): Promise<{ repoId: string; name: string }> {
  const src = (await db.select().from(repositories).where(eq(repositories.id, sourceRepoId)).limit(1))[0];
  if (!src) throw new NotFoundError("repo");
  const owner = (await db.select().from(users).where(eq(users.id, ownerUserId)).limit(1))[0];
  if (!owner) throw new NotFoundError("user");
  if (!owner.username) throw new ValidationError("set a username before forking (run `ch login`)");

  // #138 — see forkRepo.
  const name = newName == null ? src.name : assertSafeRepoName(newName, "name");
  const existing = (await db.select().from(repositories).where(and(
    eq(repositories.namespaceType, "user"),
    eq(repositories.namespaceId, ownerUserId),
    eq(repositories.name, name),
  )).limit(1))[0];
  if (existing) throw new ConflictError("repo already exists for this owner");

  const srcNs = await namespaceNameOf(db, src.namespaceType, src.namespaceId);
  if (!srcNs) throw new NotFoundError("source namespace");

  const srcPath = git.pathOf(srcNs, src.name);
  const destPath = git.pathOf(owner.username, name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(destPath, { recursive: true });
  const simpleGit = (await import("simple-git")).default;
  await simpleGit().clone(srcPath, destPath, ["--mirror"]);

  const [row] = await db.insert(repositories).values({
    name,
    namespaceType: "user",
    namespaceId: ownerUserId,
    description: src.description,
    defaultBranch: src.defaultBranch,
    isPublic: src.isPublic,
    forkOfRepoId: src.id,
    topics: src.topics,
    language: src.language,
  }).returning();

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

/**
 * Target-side accept: MATERIALIZE an incoming cross-repo proposal as a normal,
 * reviewable Change in the target repo (so it obeys the target's merge policy).
 * Imports the proposed commits from the source (fork) bare repo into the target
 * as a `proposal-<id8>` branch, then inserts a Change row pointing at them.
 *
 * Local bare-repo fetch only — a sharded target throws a clear error (the cross-
 * shard pack transfer is a later piece). Returns the new Change id.
 */
export async function acceptCrossRepoProposal(db: DB, git: GitService, events: EventBus, proposalId: string): Promise<{ changeId: string }> {
  // Serialize per target repo: the status guard + materialize + status flip then
  // can't race a concurrent double-accept (which previously raced to a 500 / a
  // second Change).
  const targetRepoId = (await db.select({ targetRepoId: crossRepoProposals.targetRepoId }).from(crossRepoProposals).where(eq(crossRepoProposals.id, proposalId)).limit(1))[0]?.targetRepoId;
  if (!targetRepoId) throw new NotFoundError("proposal");
  return withRepoLock(targetRepoId, async () => {
    const prop = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.id, proposalId)).limit(1))[0];
    if (!prop) throw new NotFoundError("proposal");
    if (prop.status !== "open") throw new ConflictError(`proposal is already ${prop.status}`);
    const srcChange = (await db.select().from(changes).where(eq(changes.id, prop.changeId)).limit(1))[0];
    if (!srcChange) throw new NotFoundError("source change");
    const srcRepo = (await db.select().from(repositories).where(eq(repositories.id, srcChange.repoId)).limit(1))[0];
    const target = (await db.select().from(repositories).where(eq(repositories.id, prop.targetRepoId)).limit(1))[0];
    if (!srcRepo || !target) throw new NotFoundError("repo");
    const srcNs = await namespaceNameOf(db, srcRepo.namespaceType, srcRepo.namespaceId);
    const targetNs = await namespaceNameOf(db, target.namespaceType, target.namespaceId);
    if (!srcNs || !targetNs) throw new NotFoundError("namespace");

    // Use the FULL proposal id so the ref is globally unique (8 hex chars could
    // collide across proposals and clobber a prior import).
    const proposalBranch = `proposal-${prop.id}`;
    const srcPath = git.pathOf(srcNs, srcRepo.name);
    const targetPath = git.pathOf(targetNs, target.name);
    const simpleGit = (await import("simple-git")).default;
    try {
      await simpleGit(targetPath).fetch([srcPath, `+${srcChange.branch}:refs/heads/${proposalBranch}`]);
    } catch (e) {
      throw new ValidationError(`could not import the proposed commits into the target (cross-shard proposals aren't supported yet): ${(e as Error).message}`);
    }

    const [newChange] = await db.insert(changes).values({
      repoId: target.id,
      branch: proposalBranch,
      headCommit: srcChange.headCommit,
      intent: srcChange.intent,
      risk: srcChange.risk,
      riskReasons: srcChange.riskReasons,
      scope: srcChange.scope,
      changedPaths: srcChange.changedPaths,
      reviewFocus: srcChange.reviewFocus,
      trailers: srcChange.trailers,
      openedByAgentId: srcChange.openedByAgentId,
      openedByUserId: srcChange.openedByUserId,
      status: "pending",
    }).returning();
    await db.insert(branches).values({ repoId: target.id, name: proposalBranch, headCommit: srcChange.headCommit })
      .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { headCommit: srcChange.headCommit } });

    // CI: run the TARGET's push pipelines against the imported head (so the
    // target's CI gate is actually exercised), or mark skipped when there are
    // none — otherwise the Change is stuck at ciStatus=pending and can never
    // satisfy a ciRequired merge policy. Mirrors post-push.
    const pipelines = (await db.select().from(ciPipelines).where(and(eq(ciPipelines.repoId, target.id), eq(ciPipelines.enabled, true))))
      .filter(pl => pl.triggerKind === "push");
    for (const pl of pipelines) {
      const runnerToken = randomToken(18);
      const run = (await db.insert(ciRuns).values({ repoId: target.id, changeId: newChange.id, pipelineId: pl.id, runnerToken, origin: "push", triggerDepth: 0, commit: srcChange.headCommit, ...ciSchedulingStamp("push") }).returning())[0];
      await events.publish({
        type: "ci.run.queued", repoId: target.id, changeId: newChange.id,
        actorKind: srcChange.openedByUserId ? "human" : "agent",
        actorId: srcChange.openedByUserId ?? srcChange.openedByAgentId ?? "system",
        payload: { runId: run.id, repoNs: targetNs, repoName: target.name, commit: srcChange.headCommit, pipelineYaml: pl.yaml, runnerToken },
      });
    }
    if (pipelines.length === 0) {
      await db.update(changes).set({ ciStatus: "skipped" }).where(eq(changes.id, newChange.id));
    }

    await db.update(crossRepoProposals).set({ status: "accepted" }).where(eq(crossRepoProposals.id, prop.id));
    return { changeId: newChange.id };
  }, { kind: "merge", ttlMs: 60_000, waitMs: 10_000 });
}

/** Incoming open proposals targeting `repoId`, with source change + repo labels. */
export async function listIncomingProposals(db: DB, repoId: string) {
  const rows = await db.select({
    id: crossRepoProposals.id, changeId: crossRepoProposals.changeId, targetBranch: crossRepoProposals.targetBranch,
    status: crossRepoProposals.status, createdAt: crossRepoProposals.createdAt,
    intent: changes.intent, sourceBranch: changes.branch, sourceRepoId: changes.repoId,
  })
    .from(crossRepoProposals)
    .innerJoin(changes, eq(changes.id, crossRepoProposals.changeId))
    .where(and(eq(crossRepoProposals.targetRepoId, repoId), eq(crossRepoProposals.status, "open")))
    .orderBy(crossRepoProposals.createdAt);
  return rows;
}
