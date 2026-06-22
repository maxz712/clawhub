import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import type { EventBus } from "../services/events.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForWrite } from "../services/repo-access.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { acceptCrossRepoProposal, createCrossRepoProposal, forkRepo, listIncomingProposals } from "../services/forks.js";
import { changes, crossRepoProposals, repositories } from "../models/schema.js";

export function createForkRoutes(db: DB, git: GitService, events: EventBus): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/:ns/:repo/fork", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("only agents can fork");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    const result = await forkRepo(db, git, repo.id, p.agentId, body.name);
    return c.json(result, 201);
  });

  app.get("/:ns/:repo/forks", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(repositories).where(eq(repositories.forkOfRepoId, repo.id)).limit(200);
    return c.json({ forks: rows });
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

  app.get("/:ns/:repo/changes/:id/proposal", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, c.req.param("id"))).limit(1))[0];
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
