import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite, visibleRepoIds } from "../services/repo-access.js";
import { namespaceNameOf } from "../services/namespace.js";
import { NotFoundError, ValidationError } from "../services/errors.js";
import { acceptCrossRepoProposal, createCrossRepoProposal, forkRepo, forkRepoForUser, listIncomingProposals } from "../services/forks.js";
import { changes, crossRepoProposals, repositories } from "../models/schema.js";

// The fork list is a DIRECTORY of repos, not a repo settings dump. Project an
// explicit column set so the governance posture of a fork — mergePolicy
// (trustedAgents, verifiedAutonomy, auto-merge), nativeReviewerEnabled,
// platformVerifyEnabled — is never published to the parent's readers, and so the
// next column added to `repositories` is not auto-published by a `select()`.
const FORK_LIST_COLUMNS = {
  id: repositories.id,
  name: repositories.name,
  namespaceType: repositories.namespaceType,
  namespaceId: repositories.namespaceId,
  isPublic: repositories.isPublic,
  description: repositories.description,
  language: repositories.language,
  topics: repositories.topics,
  defaultBranch: repositories.defaultBranch,
  forkOfRepoId: repositories.forkOfRepoId,
  starsCount: repositories.starsCount,
  changesCount: repositories.changesCount,
  createdAt: repositories.createdAt,
  updatedAt: repositories.updatedAt,
};

export function createForkRoutes(db: DB, git: GitService, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/:ns/:repo/fork", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    // Agents fork into their service-account namespace; humans fork into their own.
    const result = p.kind === "agent"
      ? await forkRepo(db, git, repo.id, p.agentId, body.name)
      : await forkRepoForUser(db, git, repo.id, p.userId, body.name);
    return c.json(result, 201);
  });

  // Forks of THIS repo. Reading the parent authorizes the parent — it says
  // nothing about the children, and a fork inherits the parent's visibility at
  // creation but is then free to diverge (and to be made private). So every
  // candidate is re-gated: a fork is listed only when it is PUBLIC or the caller
  // actually reaches it (`visibleRepoIds` — the batch form of repoAccessFor).
  // Without this, anyone who could read a public parent got the full row of
  // every private fork, mergePolicy included.
  app.get("/:ns/:repo/forks", async c => {
    const caller = c.get("tokenPayload");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), caller);
    const rows = await db.select(FORK_LIST_COLUMNS).from(repositories).where(eq(repositories.forkOfRepoId, repo.id)).limit(200);
    const visible = rows.some(r => !r.isPublic) ? await visibleRepoIds(db, caller) : new Set<string>();
    const allowed = rows.filter(r => r.isPublic || visible.has(r.id));
    // Resolve each namespace NAME: the row only carries a (kind, id) tuple, so
    // without this the dashboard rendered every fork as "?/name" and linked it
    // into the PARENT's namespace — a dead link for any fork owned elsewhere.
    const forks = await Promise.all(allowed.map(async r => ({
      ...r, namespaceName: await namespaceNameOf(db, r.namespaceType, r.namespaceId),
    })));
    return c.json({ forks });
  });

  app.post("/:ns/:repo/changes/:id/propose", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new ValidationError("change not found");
    const body = await c.req.json().catch(() => ({})) as { targetNs?: string; targetRepo?: string; targetBranch?: string };
    if (!body.targetNs || !body.targetRepo || !body.targetBranch) throw new ValidationError("target_ns/repo/branch required");
    const target = await resolveRepoForRead(db, body.targetNs, body.targetRepo, c.get("tokenPayload"));
    await createCrossRepoProposal(db, change.id, target.repo.id, body.targetBranch);
    return c.json({ ok: true });
  });

  // The proposal a change in THIS repo has open upstream. `:id` is client-supplied,
  // so it is bound to the resolved repo first (every sibling route in this file
  // already does): without the binding, read access to any throwaway repo let a
  // caller look up another repo's proposal row by change id.
  app.get("/:ns/:repo/changes/:id/proposal", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const change = (await db.select({ id: changes.id }).from(changes)
      .where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new NotFoundError("change");
    const row = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, change.id)).limit(1))[0];
    return c.json({ proposal: row ?? null, repoId: repo.id });
  });

  // Target-side: incoming open proposals to THIS repo (the upstream maintainer's
  // inbox). Read access to the target repo.
  app.get("/:ns/:repo/incoming-proposals", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const proposals = await listIncomingProposals(db, repo.id);
    return c.json({ proposals });
  });

  // Target-side: accept an incoming proposal — materializes a reviewable Change in
  // THIS repo under its merge policy. Requires write on the target repo, and the
  // proposal must actually target this repo.
  app.post("/:ns/:repo/incoming-proposals/:proposalId/accept", async c => {
    const { repo } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const prop = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.id, c.req.param("proposalId"))).limit(1))[0];
    if (!prop || prop.targetRepoId !== repo.id) throw new NotFoundError("proposal");
    const result = await acceptCrossRepoProposal(db, git, events, prop.id);
    return c.json(result);
  });

  return app;
}
