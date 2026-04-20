import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { createCrossRepoProposal, forkRepo } from "../services/forks.js";
import { changes, crossRepoProposals, repositories } from "../models/schema.js";

export function createForkRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/:ns/:repo/fork", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("only agents can fork");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const body = await c.req.json().catch(() => ({})) as { name?: string };
    const result = await forkRepo(db, git, repo.id, p.agentId, body.name);
    return c.json(result, 201);
  });

  app.get("/:ns/:repo/forks", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(repositories).where(eq(repositories.forkOfRepoId, repo.id)).limit(200);
    return c.json({ forks: rows });
  });

  app.post("/:ns/:repo/changes/:id/propose", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const change = (await db.select().from(changes).where(and(eq(changes.id, c.req.param("id")), eq(changes.repoId, repo.id))).limit(1))[0];
    if (!change) throw new ValidationError("change not found");
    const body = await c.req.json().catch(() => ({})) as { targetNs?: string; targetRepo?: string; targetBranch?: string };
    if (!body.targetNs || !body.targetRepo || !body.targetBranch) throw new ValidationError("target_ns/repo/branch required");
    const target = await mustResolveRepo(db, body.targetNs, body.targetRepo);
    await createCrossRepoProposal(db, change.id, target.repo.id, body.targetBranch);
    return c.json({ ok: true });
  });

  app.get("/:ns/:repo/changes/:id/proposal", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const row = (await db.select().from(crossRepoProposals).where(eq(crossRepoProposals.changeId, c.req.param("id"))).limit(1))[0];
    return c.json({ proposal: row ?? null, repoId: repo.id });
  });

  return app;
}
