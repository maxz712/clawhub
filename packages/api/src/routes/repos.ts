import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { mustResolveRepo, resolveNamespace } from "../services/repo-resolver.js";
import { AuthError } from "../services/errors.js";

export function createRepoRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // List repos visible to the caller.
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind === "agent") {
      const ns = await resolveNamespace(db, p.name);
      if (!ns) return c.json({ repos: [] });
      const rows = await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, ns.id))).orderBy(desc(repositories.updatedAt));
      return c.json({ repos: rows });
    }
    // User: agents they've claimed + orgs they belong to + public repos they collaborate on.
    const ownedAgents = await db.select().from(agents).where(eq(agents.associatedUserId, p.userId));
    const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, p.userId));

    const result: Array<typeof repositories.$inferSelect> = [];
    for (const a of ownedAgents) {
      const r = await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, a.id)));
      result.push(...r);
    }
    for (const m of memberships) {
      const r = await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, m.orgId)));
      result.push(...r);
    }
    return c.json({ repos: result });
  });

  app.get("/:ns/:repo", async c => {
    const { repo, namespace } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    return c.json({ repo, namespace });
  });

  app.patch("/:ns/:repo", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertWrite(db, p, repo, namespace);
    const body = await c.req.json().catch(() => ({})) as {
      description?: string; isPublic?: boolean; defaultBranch?: string; mergePolicy?: unknown;
    };
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.description !== undefined) patch.description = body.description;
    if (body.isPublic !== undefined) patch.isPublic = body.isPublic;
    if (body.defaultBranch) patch.defaultBranch = body.defaultBranch;
    if (body.mergePolicy) patch.mergePolicy = body.mergePolicy;
    await db.update(repositories).set(patch).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  app.get("/:ns/:repo/collaborators", async c => {
    const { repo } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    const rows = await db.select().from(repoCollaborators).where(eq(repoCollaborators.repoId, repo.id));
    return c.json({ collaborators: rows });
  });

  app.post("/:ns/:repo/collaborators", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await mustResolveRepo(db, c.req.param("ns"), c.req.param("repo"));
    await assertWrite(db, p, repo, namespace);
    const body = await c.req.json().catch(() => ({})) as { agentName?: string; role?: "writer" | "reviewer" };
    if (!body.agentName) throw new AuthError("agentName required");
    const a = (await db.select().from(agents).where(eq(agents.name, body.agentName)).limit(1))[0];
    if (!a) throw new AuthError("agent not found");
    await db.insert(repoCollaborators).values({ repoId: repo.id, agentId: a.id, role: body.role ?? "writer" }).onConflictDoNothing();
    return c.json({ ok: true });
  });

  return app;
}

async function assertWrite(db: DB, payload: { kind: string; userId?: string; agentId?: string }, repo: typeof repositories.$inferSelect, ns: { kind: "agent" | "org"; id: string }) {
  if (payload.kind === "agent" && ns.kind === "agent" && ns.id === payload.agentId) return;
  if (payload.kind === "agent") {
    const c = (await db.select().from(repoCollaborators).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, payload.agentId!))).limit(1))[0];
    if (c) return;
  }
  if (payload.kind === "user") {
    if (ns.kind === "agent") {
      const a = (await db.select().from(agents).where(and(eq(agents.id, ns.id), eq(agents.associatedUserId, payload.userId!))).limit(1))[0];
      if (a) return;
    }
    if (ns.kind === "org") {
      const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, ns.id), eq(orgMembers.userId, payload.userId!))).limit(1))[0];
      if (m) return;
    }
  }
  throw new AuthError("forbidden");
}
