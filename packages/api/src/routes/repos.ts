import { Hono } from "hono";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { GitService } from "../services/git.js";
import { resolveNamespace } from "../services/repo-resolver.js";
import { resolveRepoForRead, resolveRepoForWrite, resolveRepoForAdmin } from "../services/repo-access.js";
import { namespaceNameOf, type NamespaceKind } from "../services/namespace.js";
import { AuthError, ConflictError, ValidationError } from "../services/errors.js";
import { applySoloModePreset, type MergePolicy } from "../services/merge-policy.js";

/** Attach the resolved namespace name to each repo row for the dashboard. */
async function withNamespaceName(db: DB, rows: Array<typeof repositories.$inferSelect>) {
  return Promise.all(rows.map(async r => ({ ...r, namespaceName: await namespaceNameOf(db, r.namespaceType, r.namespaceId) })));
}

export function createRepoRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // List repos visible to the caller.
  app.get("/", async c => {
    const p = c.get("tokenPayload");
    const result: Array<typeof repositories.$inferSelect> = [];
    const seen = new Set<string>();
    const add = (rows: Array<typeof repositories.$inferSelect>) => {
      for (const r of rows) if (!seen.has(r.id)) { result.push(r); seen.add(r.id); }
    };

    if (p.kind === "agent") {
      // Repos the agent can write to: explicit collaborator grants, plus any
      // legacy repos still owned by its own agent namespace (transitional).
      const grants = await db.select().from(repoCollaborators).where(eq(repoCollaborators.agentId, p.agentId));
      const repoIds = grants.map(g => g.repoId);
      if (repoIds.length) add(await db.select().from(repositories).where(inArray(repositories.id, repoIds)));
      add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, p.agentId))));
      result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return c.json({ repos: await withNamespaceName(db, result) });
    }

    // User: repos they own (their handle), repos owned by service accounts of
    // agents they've claimed, their orgs' repos, and legacy agent-owned repos.
    const ownedAgents = await db.select().from(agents).where(eq(agents.associatedUserId, p.userId));
    const memberships = await db.select().from(orgMembers).where(eq(orgMembers.userId, p.userId));
    const ownerUserIds = [p.userId, ...ownedAgents.map(a => a.serviceUserId).filter((x): x is string => !!x)];

    add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "user"), inArray(repositories.namespaceId, ownerUserIds))));
    for (const m of memberships) {
      add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, m.orgId))));
    }
    for (const a of ownedAgents) {
      add(await db.select().from(repositories).where(and(eq(repositories.namespaceType, "agent"), eq(repositories.namespaceId, a.id))));
    }
    result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return c.json({ repos: await withNamespaceName(db, result) });
  });

  app.get("/:ns/:repo", async c => {
    const { repo, namespace } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    return c.json({ repo, namespace });
  });

  app.patch("/:ns/:repo", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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

  // One-action "Solo mode" for a team of one. Hand-tuning the four interacting
  // merge-policy fields (allowSelfReview/minApprovals*/requireHumanApproval) is
  // a trap, and the in-repo `.clawhub/policies/merge.yml` route is itself a
  // sensitive path that needs a human to merge — chicken-and-egg for a brand-new
  // solo repo. This is the discoverable, governance-aware opt-out: it lets the
  // owner approve their own low/medium work while KEEPING the sensitive-path and
  // high-risk code-review backstops. Backs the dashboard "Solo mode" button and
  // the `ch repo solo-mode` CLI command so both apply the SAME canonical preset.
  app.post("/:ns/:repo/merge-policy/solo-mode", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertWrite(db, p, repo, namespace);
    const mergePolicy = applySoloModePreset(repo.mergePolicy as MergePolicy);
    await db.update(repositories).set({ mergePolicy, updatedAt: new Date() }).where(eq(repositories.id, repo.id));
    return c.json({ ok: true, mergePolicy });
  });

  // Transfer ownership of a repo to a user or org namespace. This is the
  // path-MOVING operation (the on-disk bare repo is relocated), used to re-home
  // a repo under a human's handle. Only the current controller (a human who can
  // write the source) may transfer, and only INTO a namespace they control. The
  // previous owner agent (if it was a legacy agent namespace) is granted writer
  // so it keeps pushing. Sharded repos aren't supported here (local backend only).
  app.post("/:ns/:repo/transfer", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const { repo, namespace } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertWrite(db, p, repo, namespace);

    const body = await c.req.json().catch(() => ({})) as { to?: string };
    if (!body.to) throw new ValidationError("to required");
    const target = await resolveNamespace(db, body.to);
    if (!target || target.kind === "agent") throw new ValidationError("target must be an existing user or org namespace");
    if (target.kind === "user" && target.id !== p.userId) throw new AuthError("cannot transfer into another user's namespace");
    if (target.kind === "org") {
      const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, target.id), eq(orgMembers.userId, p.userId))).limit(1))[0];
      if (!m) throw new AuthError("not a member of the target org");
    }
    if (repo.namespaceType === target.kind && repo.namespaceId === target.id) {
      return c.json({ ok: true, namespace: { kind: target.kind, name: target.name } });
    }
    const clash = (await db.select().from(repositories).where(and(
      eq(repositories.namespaceType, target.kind), eq(repositories.namespaceId, target.id), eq(repositories.name, repo.name),
    )).limit(1))[0];
    if (clash) throw new ConflictError("a repo with that name already exists in the target namespace");

    // Relocate the bare repo on disk (only when the namespace NAME changes).
    const oldNs = namespace.name;
    const newNs = target.name;
    let moved = false;
    if (oldNs !== newNs) {
      if (!(await git.exists(oldNs, repo.name))) throw new ValidationError("repo not on local storage; transfer is unsupported for sharded repos");
      const fs = await import("node:fs/promises");
      const oldPath = git.pathOf(oldNs, repo.name);
      const newPath = git.pathOf(newNs, repo.name);
      await fs.mkdir(path.dirname(newPath), { recursive: true });
      await fs.rename(oldPath, newPath);
      moved = true;
    }
    try {
      if (namespace.kind === "agent") {
        await db.insert(repoCollaborators).values({ repoId: repo.id, agentId: namespace.id, role: "writer" }).onConflictDoNothing();
      }
      await db.update(repositories).set({ namespaceType: target.kind, namespaceId: target.id, updatedAt: new Date() }).where(eq(repositories.id, repo.id));
    } catch (e) {
      // Roll the disk move back so DB and filesystem stay consistent.
      if (moved) { const fs = await import("node:fs/promises"); await fs.rename(git.pathOf(newNs, repo.name), git.pathOf(oldNs, repo.name)).catch(() => {}); }
      throw e;
    }
    return c.json({ ok: true, namespace: { kind: target.kind, name: newNs } });
  });

  app.get("/:ns/:repo/collaborators", async c => {
    const { repo } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const rows = await db.select().from(repoCollaborators).where(eq(repoCollaborators.repoId, repo.id));
    return c.json({ collaborators: rows });
  });

  app.post("/:ns/:repo/collaborators", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForWrite(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
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

async function assertWrite(db: DB, payload: { kind: string; userId?: string; agentId?: string }, repo: typeof repositories.$inferSelect, ns: { kind: NamespaceKind; id: string }) {
  if (payload.kind === "agent" && ns.kind === "agent" && ns.id === payload.agentId) return;
  if (payload.kind === "agent") {
    const c = (await db.select().from(repoCollaborators).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, payload.agentId!))).limit(1))[0];
    if (c) return;
  }
  if (payload.kind === "user") {
    // The user owns the repo's namespace directly.
    if (ns.kind === "user" && ns.id === payload.userId) return;
    // Legacy agent namespace claimed by this user.
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
