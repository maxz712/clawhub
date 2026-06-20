import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo } from "../services/repo-resolver.js";
import type { NamespaceKind } from "../services/namespace.js";
import { AuthError, ForbiddenError, ValidationError } from "../services/errors.js";
import {
  batchWriteMemory, consolidationCandidates, invalidateMemory, listRepoMemories,
  redactMemory, resolveScopeIds, searchMemory, superviseMemory, writeMemory,
  type WriteMemoryInput,
} from "../services/memory.js";

/** An agent may read/write memory for a repo iff it's a collaborator (it can act on the repo). */
async function assertAgentRepoAccess(db: DB, agentId: string, repoId: string): Promise<void> {
  const c = (await db.select({ id: repoCollaborators.id }).from(repoCollaborators)
    .where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.agentId, agentId))).limit(1))[0];
  if (!c) throw new ForbiddenError("agent is not a collaborator on this repo");
}

/** A human may view/supervise memory iff they own the repo namespace / are an org member. */
async function assertHumanRepoAccess(db: DB, userId: string, repo: typeof repositories.$inferSelect, ns: { kind: NamespaceKind; id: string }): Promise<void> {
  if (ns.kind === "user" && ns.id === userId) return;
  if (ns.kind === "agent") {
    const a = (await db.select().from(agents).where(and(eq(agents.id, ns.id), eq(agents.associatedUserId, userId))).limit(1))[0];
    if (a) return;
  }
  if (ns.kind === "org") {
    const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, ns.id), eq(orgMembers.userId, userId))).limit(1))[0];
    if (m) return;
  }
  throw new ForbiddenError("forbidden");
}

export function createMemoryRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // READ — agent gets its scoped union; a human gets the repo view.
  app.get("/:ns/:repo/memory", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const q = c.req.query();
    if (p.kind === "agent") {
      await assertAgentRepoAccess(db, p.agentId, repo.id);
      const ids = await resolveScopeIds(db, p.agentId, repo.id);
      const rows = await searchMemory(db, ids, {
        query: q.q, kind: q.kind, fingerprint: q.fingerprint,
        asOf: q.as_of ? new Date(q.as_of) : undefined,
        changedPaths: q.paths ? q.paths.split(",") : undefined,
        limit: q.limit ? Math.min(100, Number(q.limit)) : undefined,
      });
      return c.json({ memories: rows.map(redactMemory) });
    }
    await assertHumanRepoAccess(db, p.userId, repo, namespace);
    const rows = await listRepoMemories(db, repo.id, { kind: q.kind, includeArchived: q.archived === "1", limit: q.limit ? Math.min(200, Number(q.limit)) : undefined });
    return c.json({ memories: rows.map(redactMemory) });
  });

  // WRITE — agent only.
  app.post("/:ns/:repo/memory", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required to write memory");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const body = await c.req.json().catch(() => ({})) as WriteMemoryInput;
    const row = await writeMemory(db, ids, body);
    return c.json({ memory: row ? redactMemory(row) : null }, row ? 201 : 200);
  });

  // BATCH WRITE — end-of-run flush.
  app.post("/:ns/:repo/memory/batch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required to write memory");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const body = await c.req.json().catch(() => ({})) as { memories?: WriteMemoryInput[]; runId?: string };
    if (!Array.isArray(body.memories)) throw new ValidationError("memories array required");
    const r = await batchWriteMemory(db, ids, body.memories, body.runId);
    return c.json(r);
  });

  // CONSOLIDATION CANDIDATES — clustered duplicates for the agent to merge.
  app.get("/:ns/:repo/memory/consolidation-candidates", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const clusters = await consolidationCandidates(db, ids);
    return c.json({ clusters: clusters.map(cl => ({ key: cl.key, memories: cl.memories.map(redactMemory) })) });
  });

  // INVALIDATE — agent soft-invalidates a memory in its scope.
  app.delete("/:ns/:repo/memory/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required");
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    await invalidateMemory(db, ids, c.req.param("id"));
    return c.json({ ok: true });
  });

  // SUPERVISE — human pin / archive (veto) / un-archive a memory.
  app.patch("/:ns/:repo/memory/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const { repo, namespace } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertHumanRepoAccess(db, p.userId, repo, namespace);
    const body = await c.req.json().catch(() => ({})) as { action?: string };
    if (!["pin", "unpin", "archive", "unarchive"].includes(body.action ?? "")) throw new ValidationError("action must be pin|unpin|archive|unarchive");
    const row = await superviseMemory(db, repo.id, c.req.param("id"), p.userId, body.action as "pin" | "unpin" | "archive" | "unarchive");
    return c.json({ memory: redactMemory(row) });
  });

  return app;
}
