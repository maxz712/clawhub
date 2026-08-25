import { Hono } from "hono";
import path from "node:path";
import { and, eq, inArray, or } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { agents, branches, orgMembers, repoCollaborators, repositories, standingAgents, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import type { GitService } from "../services/git.js";
import { resolveNamespace } from "../services/repo-resolver.js";
import { resolveRepoForRead, resolveRepoForAdmin, visibleRepos } from "../services/repo-access.js";
import { namespaceNameOf, type NamespaceKind } from "../services/namespace.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { applySoloModePreset, normalizeMergePolicy, type MergePolicy } from "../services/merge-policy.js";
import { planFor, requireEntitlement } from "../services/entitlements.js";
import { catalogEntry } from "../services/llm-catalog.js";
import { ensureNativeReviewerForRepo, NATIVE_REVIEWER_STANDING_NAME } from "../services/native-reviewer.js";
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
    // ONE visibility implementation (#187): `visibleRepos` is the batch form of
    // `repoAccessFor`. The hand-rolled block this replaced never queried
    // `repo_collaborators` on the human branch, so a repo someone was explicitly
    // invited to — the single-repo human grant this list exists to surface —
    // appeared here for nobody but its owner.
    //
    // `includeAgentSponsorNamespaces: false` keeps AGENT callers on exactly the
    // list they have always had (explicit grants + their legacy namespace). This
    // is a ROSTER, not an authorization filter: `repoAccessFor` also admits an
    // agent to its sponsoring human's namespaces and orgs, so including those
    // would make a freshly-created, grant-less agent list its sponsor's entire
    // org here — a scope change nobody asked for, in the list `ch` reads back as
    // "the repos I work on".
    const result = await visibleRepos(db, c.get("tokenPayload"), { includeAgentSponsorNamespaces: false });
    result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return c.json(await paginate(db, result, c.req.query()));
  });

  app.get("/:ns/:repo", async c => {
    const { repo, namespace, access } = await resolveRepoForRead(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    // Normalize the stored merge policy on READ too. Writes go through
    // normalizeMergePolicy, but a row written by an older path (or predating a
    // field) can be missing arrays like trustedAgents/pathOverrides — the
    // dashboard Policy tab then crashes on `.map`/`.join`. Normalizing here keeps
    // the shape complete without a migration.
    const safeRepo = { ...repo, mergePolicy: normalizeMergePolicy(repo.mergePolicy) };
    // `access` is the caller's level (read|review|write|admin). The dashboard
    // uses it to decide whether to OFFER merge actions (write+) vs review-only,
    // so a reviewer-role caller sees Approve but not Merge.
    //
    // Repo metadata (#33): on-disk size, commit count, file count — only when
    // asked (`?stats=1`), since it spawns git subprocesses we don't want on the
    // hot read path every repo header hits. Best-effort: any failure (e.g. a
    // sharded repo with no local checkout) yields null legs, never a 500.
    let stats: { sizeBytes: number | null; commits: number | null; files: number | null } | undefined;
    if (c.req.query("stats") === "1") {
      try { stats = await git.stats(namespace.name, repo.name, repo.defaultBranch); }
      catch { stats = { sizeBytes: null, commits: null, files: null }; }
    }
    return c.json({ repo: safeRepo, namespace, access, ...(stats ? { stats } : {}) });
  });

  app.patch("/:ns/:repo", async c => {
    const p = c.get("tokenPayload");
    const { repo, namespace } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    await assertWrite(db, p, repo, namespace);
    const body = await c.req.json().catch(() => ({})) as {
      description?: string; isPublic?: boolean; defaultBranch?: string; mergePolicy?: unknown;
      nativeReviewerEnabled?: boolean | null; platformVerifyEnabled?: boolean | null;
    };
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.description !== undefined) patch.description = body.description;
    if (body.isPublic !== undefined) patch.isPublic = body.isPublic;
    if (body.defaultBranch) patch.defaultBranch = body.defaultBranch;
    // Native advisory reviewer opt-out (M4). Tri-state: null = platform default,
    // true = force on, false = opted out. Any other value coerces to null.
    if (body.nativeReviewerEnabled !== undefined) {
      patch.nativeReviewerEnabled = body.nativeReviewerEnabled === true ? true : body.nativeReviewerEnabled === false ? false : null;
    }
    // Platform-keyed verify opt-in (D10). Metered $2 e2e run — OFF unless turned on.
    if (body.platformVerifyEnabled !== undefined) {
      patch.platformVerifyEnabled = body.platformVerifyEnabled === true ? true : body.platformVerifyEnabled === false ? false : null;
    }
    // Normalize the free-form policy into a complete, safe shape before storing
    // (a partial body would otherwise brick/weaken this repo's merge gating).
    if (body.mergePolicy) patch.mergePolicy = normalizeMergePolicy(body.mergePolicy);
    await db.update(repositories).set(patch).where(eq(repositories.id, repo.id));
    return c.json({ ok: true });
  });

  // Full, IRREVERSIBLE repo deletion. Gated hard because it destroys everything
  // under the repo — every repoId-referencing row cascades (changes, reviews,
  // issues, CI runs, secrets, releases, stars/watchers, …) plus the on-disk bare
  // repo. Three independent gates:
  //   1) HUMAN ONLY  — an agent token can never reach a destructive full-delete
  //      (checked first, before any DB work, so an agent is refused outright).
  //   2) repo ADMIN  — resolveRepoForAdmin (owner user / org admin / admin collab);
  //      a non-admin gets 403, an invisible repo 404 (no existence leak).
  //   3) TYPED CONFIRM — the body must echo the exact "<ns>/<repo>" path
  //      (GitHub-style), so a misfire can't nuke the wrong repo.
  // Audited as repo.deleted with repoId:null (a repoId would itself cascade away
  // with the repo, erasing the audit trail) — identity lives in metadata.
  app.delete("/:ns/:repo", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new ForbiddenError("repo deletion requires a human user token", "users_only");
    const { repo, namespace } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), p);
    const full = `${namespace.name}/${repo.name}`;
    const body = await c.req.json().catch(() => ({})) as { confirm?: string };
    if (body.confirm !== full) throw new ValidationError(`to delete this repo send { "confirm": "${full}" }`);
    await getAuditLog(db).record({
      repoId: null,
      actorKind: "human",
      actorId: p.userId,
      action: "repo.deleted", category: "repo",
      metadata: { namespace: namespace.name, repo: repo.name, repoId: repo.id },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    // DB row first — cascades to all repoId-referencing rows; then the on-disk
    // bare repo (best-effort; a sharded repo's data plane is out of scope here,
    // mirroring the transfer route's local-storage assumption).
    await db.delete(repositories).where(eq(repositories.id, repo.id));
    await git.remove(namespace.name, repo.name).catch(() => {});
    return c.json({ ok: true, deleted: full });
  });

  // Per-branch protection editor write path. Team+ entitlement-gated
  // (branchProtection is a paid feature) + repo-admin authz. Stores the
  // sanitized rules on branches.protection (jsonb), enforced by changes.ts
  // (merge methods / CI / required approvals / requirePullRequest) and
  // post-push.ts (block force-push / deletion). `{ clear: true }` removes
  // protection from the branch.
  // N3 model selector: pin (or clear) THIS repo's platform review model. The pin
  // lives on the repo's system-reviewer standing row (`model`), is validated
  // against the qualified catalog at set time, and beats the risk-tier router at
  // dispatch — the gateway still refuses anything outside the catalog.
  app.get("/:ns/:repo/native-reviewer-model", async c => {
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const row = (await db.select({ model: standingAgents.model }).from(standingAgents)
      .where(and(eq(standingAgents.repoId, repo.id), eq(standingAgents.name, NATIVE_REVIEWER_STANDING_NAME))).limit(1))[0];
    return c.json({ model: row?.model ?? null });
  });
  app.put("/:ns/:repo/native-reviewer-model", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), p);
    const body = await c.req.json().catch(() => ({})) as { model?: string | null };
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
    if (model && !catalogEntry(model)) throw new ValidationError(`model "${model}" is not in the qualified platform catalog`);
    const sa = await ensureNativeReviewerForRepo(db, repo.id);
    await db.update(standingAgents).set({ model }).where(eq(standingAgents.id, sa.id));
    return c.json({ model });
  });

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
    // Resolve agent + human names so the response is meaningful, not bare UUIDs.
    const agentIds = rows.map(r => r.agentId).filter((x): x is string => !!x);
    const userIds = rows.map(r => r.userId).filter((x): x is string => !!x);
    const agentRows = agentIds.length ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [];
    const userRows = userIds.length ? await db.select({ id: users.id, username: users.username, email: users.email }).from(users).where(inArray(users.id, userIds)) : [];
    const agentName = new Map(agentRows.map(a => [a.id, a.name]));
    const userName = new Map(userRows.map(u => [u.id, u.username ?? u.email]));
    return c.json({
      collaborators: rows.map(r => r.userId
        ? { kind: "human" as const, userId: r.userId, name: userName.get(r.userId) ?? null, role: r.role, createdAt: r.createdAt }
        // agentId/agentName kept for back-compat with existing callers.
        : { kind: "agent" as const, agentId: r.agentId, agentName: r.agentId ? agentName.get(r.agentId) ?? null : null, name: r.agentId ? agentName.get(r.agentId) ?? null : null, role: r.role, createdAt: r.createdAt }),
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

  // --- HUMAN collaborators: give ONE person access to ONE repo without granting
  // whole-org membership. Admin-gated like agent collaborators. Keyed by the
  // user's handle or email. (Owners + org members reach the repo through the
  // namespace and are not listed/managed here.) -----------------------------
  async function resolveUserByHandleOrEmail(handleOrEmail: string) {
    const v = handleOrEmail.trim().toLowerCase();
    return (await db.select().from(users).where(or(eq(users.username, v), eq(users.email, v))).limit(1))[0];
  }

  app.post("/:ns/:repo/collaborators/users", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { handle?: string; role?: "writer" | "reviewer" };
    if (!body.handle) throw new ValidationError("handle (username or email) required");
    if (body.role !== undefined && !COLLAB_ROLES.has(body.role)) throw new ValidationError("role must be writer or reviewer");
    const u = await resolveUserByHandleOrEmail(body.handle);
    if (!u) throw new NotFoundError("user");
    // Don't shadow ownership/org access with a redundant collaborator row.
    if (repo.namespaceType === "user" && repo.namespaceId === u.id) throw new ValidationError("user already owns this repo");
    const role = body.role ?? "writer";
    await db.insert(repoCollaborators).values({ repoId: repo.id, userId: u.id, role })
      .onConflictDoUpdate({ target: [repoCollaborators.repoId, repoCollaborators.userId], set: { role } });
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.added", category: "repo",
      metadata: { targetUserId: u.id, targetUserName: u.username ?? u.email, role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role });
  });

  app.patch("/:ns/:repo/collaborators/users/:handle", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const body = await c.req.json().catch(() => ({})) as { role?: "writer" | "reviewer" };
    if (!body.role || !COLLAB_ROLES.has(body.role)) throw new ValidationError("role must be writer or reviewer");
    const u = await resolveUserByHandleOrEmail(decodeURIComponent(c.req.param("handle")));
    if (!u) throw new NotFoundError("user");
    const existing = (await db.select().from(repoCollaborators).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, u.id))).limit(1))[0];
    if (!existing) throw new NotFoundError("collaborator");
    await db.update(repoCollaborators).set({ role: body.role }).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, u.id)));
    // Audit grant changes — a human role escalation is governance-sensitive, same
    // as the agent-collaborator PATCH above.
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.role_changed", category: "repo",
      metadata: { targetUserId: u.id, targetUserName: u.username ?? u.email, fromRole: existing.role, role: body.role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role: body.role });
  });

  app.delete("/:ns/:repo/collaborators/users/:handle", async c => {
    const p = c.get("tokenPayload");
    const { repo } = await resolveRepoForAdmin(db, c.req.param("ns"), c.req.param("repo"), c.get("tokenPayload"));
    const u = await resolveUserByHandleOrEmail(decodeURIComponent(c.req.param("handle")));
    if (!u) throw new NotFoundError("user");
    const existing = (await db.select().from(repoCollaborators).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, u.id))).limit(1))[0];
    if (!existing) throw new NotFoundError("collaborator");
    await db.delete(repoCollaborators).where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, u.id)));
    await getAuditLog(db).record({
      repoId: repo.id, actorKind: p.kind === "user" ? "human" : "agent", actorId: p.kind === "user" ? p.userId : p.agentId,
      action: "collaborator.removed", category: "repo",
      metadata: { targetUserId: u.id, targetUserName: u.username ?? u.email, role: existing.role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
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
    // A service-user namespace (headless/personal agent) governed by the human
    // who claimed the agent — same membership rule as repo-access.ts.
    if (ns.kind === "user") {
      const a = (await db.select().from(agents).where(and(eq(agents.serviceUserId, ns.id), eq(agents.associatedUserId, payload.userId!))).limit(1))[0];
      if (a) return;
    }
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
  // 403, NOT 401: the dashboard treats user-token 401s as session expiry and
  // logs the user out — a permissions denial must never do that.
  throw new ForbiddenError("not authorized to write this repo");
}
