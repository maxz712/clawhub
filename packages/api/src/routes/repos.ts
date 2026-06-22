import { Hono } from "hono";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, orgMembers, repoCollaborators, repositories } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { GitService } from "../services/git.js";
import { resolveNamespace } from "../services/repo-resolver.js";
import { resolveRepoForRead, resolveRepoForAdmin } from "../services/repo-access.js";
import { namespaceNameOf, type NamespaceKind } from "../services/namespace.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../services/errors.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { applySoloModePreset, type MergePolicy } from "../services/merge-policy.js";
import { planFor, requireEntitlement } from "../services/entitlements.js";
import type { BranchProtection, MergeMethod } from "../services/changes.js";

const MERGE_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

// Keep only the known, validated branch-protection fields from an untrusted body.
function sanitizeProtection(b: Record<string, unknown>): BranchProtection {
  const p: BranchProtection = {};
  if (typeof b.requirePullRequest === "boolean") p.requirePullRequest = b.requirePullRequest;
  if (typeof b.requiredApprovals === "number" && Number.isFinite(b.requiredApprovals) && b.requiredApprovals >= 0) {
    p.requiredApprovals = Math.min(Math.floor(b.requiredApprovals), 10);
  }
  if (typeof b.requireCiSuccess === "boolean") p.requireCiSuccess = b.requireCiSuccess;
  if (typeof b.blockDeletion === "boolean") p.blockDeletion = b.blockDeletion;
  if (typeof b.blockForcePush === "boolean") p.blockForcePush = b.blockForcePush;
  if (Array.isArray(b.allowedMergeMethods)) {
    const methods = b.allowedMergeMethods.filter((m): m is MergeMethod => typeof m === "string" && MERGE_METHODS.includes(m as MergeMethod));
    if (methods.length) p.allowedMergeMethods = methods;
  }
  return p;
}

/** Attach the resolved namespace name to each repo row for the dashboard. */
async function withNamespaceName(db: DB, rows: Array<typeof repositories.$inferSelect>) {
  return Promise.all(rows.map(async r => ({ ...r, namespaceName: await namespaceNameOf(db, r.namespaceType, r.namespaceId) })));
}

/**
 * Apply an optional name/namespace filter (`q`) and limit/offset paging to the
 * already-scoped repo list, then resolve namespace names for the page only.
 * Runs entirely in memory over the caller's visible set — it cannot widen
 * visibility. Returns `{ repos, total, hasMore, limit, offset }`. With no
 * params it returns every visible repo (back-compat) with the same envelope.
 */
async function paginate(
  db: DB,
  scoped: Array<typeof repositories.$inferSelect>,
  query: Record<string, string>,
) {
  const q = (query.q ?? "").trim().toLowerCase();
  // Filter on the repo name and the resolved namespace name so "acme/" or a repo
  // substring both match. Resolve names once up front for the filtered set.
  let withNs = await withNamespaceName(db, scoped);
  if (q) {
    withNs = withNs.filter(r =>
      r.name.toLowerCase().includes(q) ||
      (r.namespaceName ?? "").toLowerCase().includes(q) ||
      `${r.namespaceName ?? ""}/${r.name}`.toLowerCase().includes(q));
  }
  const total = withNs.length;
  // limit/offset are optional; clamp to sane bounds. Absent limit → no slice
  // (preserve the old "return everything" behavior).
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const hasLimit = Number.isFinite(rawLimit) && rawLimit > 0;
  const limit = hasLimit ? Math.min(Math.floor(rawLimit), 200) : total;
  const page = (offset || hasLimit) ? withNs.slice(offset, offset + limit) : withNs;
  return { repos: page, total, hasMore: offset + page.length < total, limit, offset };
}

export function createRepoRoutes(db: DB, git: GitService): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  // List repos visible to the caller.
  //
  // Scale (FLEET-MANAGER): the visibility scoping below is UNCHANGED — a caller
  // still only ever sees repos they own / supervise / are granted. Optional
  // `q` (case-insensitive name/namespace substring filter), `limit`, and
  // `offset` are applied AFTER scoping so a manager with hundreds of repos can
  // search + page without us widening what they can see. When no paging params
  // are present we return the full list (back-compat); `total`/`hasMore` are
  // always included so a paging UI can show "showing N of M".
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
      return c.json(await paginate(db, result, c.req.query()));
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
    return c.json(await paginate(db, result, c.req.query()));
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

  // Per-branch protection editor write path. Team+ entitlement-gated
  // (branchProtection is a paid feature) + repo-admin authz. Stores the
  // sanitized rules on branches.protection (jsonb), enforced by changes.ts
  // (merge methods / CI / required approvals / requirePullRequest) and
  // post-push.ts (block force-push / deletion). `{ clear: true }` removes
  // protection from the branch.
  app.patch("/:ns/:repo/branches/:name/protection", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), p);
    // Resolve the billing owner: a user namespace bills the user; an org namespace
    // bills the org; a legacy agent namespace bills the agent's owning user (so an
    // agent-owned repo under a paid human isn't wrongly told to upgrade).
    let ownerUserId = repo.namespaceType === "user" ? repo.namespaceId : null;
    if (repo.namespaceType === "agent") {
      const ag = (await db.select().from(agents).where(eq(agents.id, repo.namespaceId)).limit(1))[0];
      ownerUserId = ag?.associatedUserId ?? ag?.serviceUserId ?? null;
    }
    requireEntitlement(await planFor(db, { orgId: repo.namespaceType === "org" ? repo.namespaceId : null, userId: ownerUserId }), "branchProtection");
    const branchName = decodeURIComponent(c.req.param("name"));
    const b = (await db.select().from(branches).where(and(eq(branches.repoId, repo.id), eq(branches.name, branchName))).limit(1))[0];
    if (!b) throw new NotFoundError("branch");
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown> & { clear?: boolean };
    const protection = body.clear ? null : sanitizeProtection(body);
    await db.update(branches).set({ protection }).where(eq(branches.id, b.id));
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "agent" ? "agent" : "human",
      actorId: p.kind === "agent" ? p.agentId : p.userId,
      action: "branch.protection.updated", category: "policy",
      metadata: { branch: branchName, protection },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, protection });
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
      // Re-homing a repo UNDER an org's ownership is an org-governance act —
      // require org admin, not bare membership (a plain member shouldn't be able
      // to move arbitrary repos into the org they belong to).
      const m = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, target.id), eq(orgMembers.userId, p.userId))).limit(1))[0];
      if (!m) throw new AuthError("not a member of the target org");
      if (m.role !== "admin") throw new AuthError("only org admins can transfer repos into the org");
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
    // Resolve agent names so the response is human-meaningful, not bare UUIDs.
    const agentIds = rows.map(r => r.agentId);
    const agentRows = agentIds.length
      ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const nameById = new Map(agentRows.map(a => [a.id, a.name]));
    return c.json({
      collaborators: rows.map(r => ({
        agentId: r.agentId,
        agentName: nameById.get(r.agentId) ?? null,
        role: r.role,
        createdAt: r.createdAt,
      })),
    });
  });

  // Granting/changing/revoking collaborator access is an ADMIN operation — a
  // plain `write` collaborator must NOT be able to add or escalate other
  // collaborators (that was the privilege-escalation finding). resolveRepoForAdmin
  // is the authoritative admin gate (owner user / org admin / legacy agent owner).
  const COLLAB_ROLES = new Set(["writer", "reviewer"]);

  app.post("/:ns/:repo/collaborators", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { agentName?: string; role?: "writer" | "reviewer" };
    if (!body.agentName) throw new ValidationError("agentName required");
    if (body.role !== undefined && !COLLAB_ROLES.has(body.role)) throw new ValidationError("role must be writer or reviewer");
    const a = (await db.select().from(agents).where(eq(agents.name, body.agentName)).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
    const role = body.role ?? "writer";
    // Upsert: re-adding an existing collaborator updates its role (so the POST is
    // also the canonical "set role" — PATCH below is the explicit variant).
    await db.insert(repoCollaborators).values({ repoId: repo.id, agentId: a.id, role })
      .onConflictDoUpdate({ target: [repoCollaborators.repoId, repoCollaborators.agentId], set: { role } });
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.added",
      category: "repo",
      metadata: { targetAgentId: a.id, targetAgentName: a.name, role },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role });
  });

  app.patch("/:ns/:repo/collaborators/:agentName", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { role?: "writer" | "reviewer" };
    if (!body.role || !COLLAB_ROLES.has(body.role)) throw new ValidationError("role must be writer or reviewer");
    const a = (await db.select().from(agents).where(eq(agents.name, c.req.param("agentName"))).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
    const existing = (await db.select().from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, a.id))).limit(1))[0];
    if (!existing) throw new NotFoundError("collaborator");
    await db.update(repoCollaborators).set({ role: body.role })
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, a.id)));
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.role_changed",
      category: "repo",
      metadata: { targetAgentId: a.id, targetAgentName: a.name, fromRole: existing.role, role: body.role },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role: body.role });
  });

  app.delete("/:ns/:repo/collaborators/:agentName", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const a = (await db.select().from(agents).where(eq(agents.name, c.req.param("agentName"))).limit(1))[0];
    if (!a) throw new NotFoundError("agent");
    const existing = (await db.select().from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, a.id))).limit(1))[0];
    if (!existing) throw new NotFoundError("collaborator");
    await db.delete(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.agentId, a.id)));
    await getAuditLog(db).record({
      repoId: repo.id,
      actorKind: p.kind === "user" ? "human" : "agent",
      actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.removed",
      category: "repo",
      metadata: { targetAgentId: a.id, targetAgentName: a.name, role: existing.role },
      ip: ipFromContext(c),
      userAgent: userAgentFromContext(c),
    });
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
