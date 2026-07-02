import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agentMemories, agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { resolveRepoForRead, resolveRepoForReview, resolveRepoForWrite } from "../services/repo-access.js";
import type { NamespaceKind } from "../services/namespace.js";
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import {
  batchWriteMemory, bumpCitedMemories, consolidationCandidates, invalidateMemory,
  listRepoMemories, redactMemory, resolveScopeIds, searchMemory, superviseMemory,
  writeMemory, type WriteMemoryInput,
} from "../services/memory.js";
import { listRepoEdges, neighborsOf, writeEdges, type EdgeInput } from "../services/memory-graph.js";

/** Load a memory and assert it belongs to THIS repo (no cross-repo edge enumeration). */
async function loadRepoMemory(db: DB, repoId: string, id: string) {
  const m = (await db.select().from(agentMemories).where(and(eq(agentMemories.id, id), eq(agentMemories.repoId, repoId))).limit(1))[0];
  if (!m) throw new NotFoundError("memory");
  return m;
}

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
    const { repo, namespace } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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
    // Attach the authoring agent's name so the human view can show WHO learned
    // each memory (a repo's memory can come from several agents).
    const agentIds = [...new Set(rows.map(r => r.agentId).filter((x): x is string => !!x))];
    const names = agentIds.length
      ? Object.fromEntries((await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))).map(a => [a.id, a.name]))
      : {};
    return c.json({ memories: rows.map(r => ({ ...redactMemory(r), agentName: r.agentId ? (names[r.agentId] ?? null) : null })) });
  });

  // WRITE — agent only.
  app.post("/:ns/:repo/memory", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required to write memory");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const body = await c.req.json().catch(() => ({})) as WriteMemoryInput;
    // Agent-authored SHARED-scope (repo/org) writes land pending until a human
    // approves — forced here, never client-controlled.
    const row = await writeMemory(db, ids, body, { pendingForShared: true });
    return c.json({ memory: row ? redactMemory(row) : null }, row ? 201 : 200);
  });

  // BATCH WRITE — end-of-run flush.
  app.post("/:ns/:repo/memory/batch", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required to write memory");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const body = await c.req.json().catch(() => ({})) as { memories?: WriteMemoryInput[]; runId?: string };
    if (!Array.isArray(body.memories)) throw new ValidationError("memories array required");
    const r = await batchWriteMemory(db, ids, body.memories, body.runId, { pendingForShared: true });
    return c.json(r);
  });

  // CITED — the run reports which pack memories it actually used. The harness
  // parses citations mechanically from the CLI output; this bump is the usage
  // signal that keeps useful memories alive (ranking recency + decay survival).
  app.post("/:ns/:repo/memory/cited", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown };
    const memoryIds = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (!memoryIds.length) throw new ValidationError("ids array required");
    const bumped = await bumpCitedMemories(db, ids, memoryIds);
    return c.json({ bumped });
  });

  // CONSOLIDATION CANDIDATES — clustered duplicates for the agent to merge.
  app.get("/:ns/:repo/memory/consolidation-candidates", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required");
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    const clusters = await consolidationCandidates(db, ids);
    return c.json({ clusters: clusters.map(cl => ({ key: cl.key, memories: cl.memories.map(redactMemory) })) });
  });

  // INVALIDATE — agent soft-invalidates a memory in its scope.
  app.delete("/:ns/:repo/memory/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    await invalidateMemory(db, ids, c.req.param("id"));
    return c.json({ ok: true });
  });

  // SUPERVISE — human pin / archive (veto) / un-archive a memory.
  app.patch("/:ns/:repo/memory/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertHumanRepoAccess(db, p.userId, repo, namespace);
    const body = await c.req.json().catch(() => ({})) as { action?: string };
    if (!["pin", "unpin", "archive", "unarchive", "approve"].includes(body.action ?? "")) throw new ValidationError("action must be pin|unpin|archive|unarchive|approve");
    const row = await superviseMemory(db, repo.id, c.req.param("id"), p.userId, body.action as "pin" | "unpin" | "archive" | "unarchive" | "approve");
    return c.json({ memory: redactMemory(row) });
  });

  // GRAPH VIEW — human supervision of the repo's memory graph (nodes + edges).
  // User token only (repo view spans every agent's shared + agent_repo memory —
  // an agent must not read cross-agent memory here; it uses /memory/:id/edges).
  app.get("/:ns/:repo/memory/graph", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const { repo, namespace } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertHumanRepoAccess(db, p.userId, repo, namespace);
    const q = c.req.query();
    const nodes = await listRepoMemories(db, repo.id, { kind: q.kind, limit: q.limit ? Math.min(500, Number(q.limit)) : 300 });
    const edges = await listRepoEdges(db, nodes.map(n => n.id));
    return c.json({ nodes: nodes.map(redactMemory), edges });
  });

  // EDGES on a memory — agent authors graph edges from its own memory; agent + human
  // read the one-hop neighborhood.
  app.post("/:ns/:repo/memory/:id/edges", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "agent") throw new AuthError("agent token required to write edges");
    const { repo } = await resolveRepoForReview(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertAgentRepoAccess(db, p.agentId, repo.id);
    const ids = await resolveScopeIds(db, p.agentId, repo.id);
    await loadRepoMemory(db, repo.id, c.req.param("id")); // 404 if not in this repo
    const body = await c.req.json().catch(() => ({})) as { edges?: EdgeInput[]; runId?: string };
    if (!Array.isArray(body.edges)) throw new ValidationError("edges array required");
    const r = await writeEdges(db, ids, c.req.param("id"), body.edges, { sourceRunId: body.runId ?? null, origin: "agent" });
    return c.json(r);
  });

  app.get("/:ns/:repo/memory/:id/edges", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    if (p.kind === "agent") await assertAgentRepoAccess(db, p.agentId, repo.id);
    else await assertHumanRepoAccess(db, p.userId, repo, namespace);
    await loadRepoMemory(db, repo.id, c.req.param("id")); // 404 if not in this repo
    const edges = await neighborsOf(db, c.req.param("id"));
    return c.json({ edges });
  });

  return app;
}
