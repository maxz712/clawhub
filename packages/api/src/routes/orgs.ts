import { Hono } from "hono";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { changes, orgMembers, organizations, repositories, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";
import { getOrgMergePolicy, setOrgMergePolicy, clearOrgMergePolicy } from "../services/org-policy.js";

// Org slug rules: lowercase alphanumeric + internal hyphens, 1–39 chars, must
// start with an alphanumeric. Mirrors a handle people can put in a URL/path.
const ORG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;
// Names that would collide with first-class routes/namespaces or look official.
const RESERVED_ORG_NAMES = new Set([
  "admin", "api", "app", "auth", "billing", "blog", "changelog", "dashboard",
  "docs", "feed", "help", "internal", "leaderboard", "login", "logout", "new",
  "org", "orgs", "pricing", "public", "register", "repo", "repos", "reset",
  "settings", "skill", "sso", "status", "support", "system", "trending", "u",
  "user", "users", "well-known", "clawhub",
]);

export function createOrgRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { name?: string; displayName?: string };
    if (!body.name) throw new ValidationError("name required");
    const name = body.name.toLowerCase();
    if (!ORG_SLUG_RE.test(name)) throw new ValidationError("name must be lowercase alphanumeric with internal hyphens, 1-39 chars");
    if (RESERVED_ORG_NAMES.has(name)) throw new ValidationError("name is reserved");
    const existing = await db.select().from(organizations).where(eq(organizations.name, name)).limit(1);
    if (existing[0]) throw new ConflictError("name taken");
    const row = (await db.insert(organizations).values({ name, displayName: body.displayName }).returning())[0];
    await db.insert(orgMembers).values({ orgId: row.id, userId: payload.userId, role: "admin" });
    return c.json({ id: row.id, name: row.name, displayName: row.displayName }, 201);
  });

  app.get("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const rows = await db.select({
      id: organizations.id, name: organizations.name, displayName: organizations.displayName, role: orgMembers.role,
    })
    .from(organizations)
    .innerJoin(orgMembers, eq(orgMembers.orgId, organizations.id))
    .where(eq(orgMembers.userId, payload.userId));
    return c.json({ orgs: rows });
  });

  // Membership is org-private: only members may list it. Admins are surfaced so
  // the caller can see who can govern the org.
  app.get("/:id/members", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const self = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId))).limit(1))[0];
    if (!self) throw new ForbiddenError("not a member of this org");
    const rows = await db.select({
      userId: orgMembers.userId, role: orgMembers.role, createdAt: orgMembers.createdAt,
      username: users.username, name: users.name, email: users.email,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, orgId));
    return c.json({ members: rows });
  });

  // Org-default merge policy. Member read; ADMIN write. Applied to NEW org repos
  // at creation; per-repo policy / in-repo merge.yml override after.
  app.get("/:id/merge-policy", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const self = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId))).limit(1))[0];
    if (!self) throw new ForbiddenError("not a member of this org");
    return c.json({ policy: await getOrgMergePolicy(db, orgId) });
  });

  app.put("/:id/merge-policy", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("org admin required to set the default merge policy");
    const body = await c.req.json().catch(() => ({})) as { policy?: unknown; clear?: boolean };
    if (body.clear) { await clearOrgMergePolicy(db, orgId); return c.json({ ok: true, policy: null }); }
    if (!body.policy || typeof body.policy !== "object") throw new ValidationError("policy object required");
    // setOrgMergePolicy normalizes the free-form body into a complete, safe
    // policy before persisting (missing/garbage fields can't brick or weaken the
    // gating that new org repos inherit). Return the normalized result.
    const policy = await setOrgMergePolicy(db, orgId, body.policy);
    await getAuditLog(db).record({
      repoId: null, actorKind: "human", actorId: payload.userId,
      action: "org.merge_policy.updated", category: "policy", metadata: { orgId },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, policy });
  });

  // N3 · org provider allowlist: which OpenRouter provider slugs this org's
  // platform-keyed runs may route to (compliance narrowing over the catalog pin;
  // NULL/empty = every qualified host). Read = member; write = admin.
  app.get("/:id/llm-providers", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const self = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId))).limit(1))[0];
    if (!self) throw new ForbiddenError("not a member of this org");
    const org = (await db.select({ allow: organizations.llmProviderAllowlist }).from(organizations).where(eq(organizations.id, orgId)).limit(1))[0];
    const allow = Array.isArray(org?.allow) ? (org.allow as unknown[]).filter((x): x is string => typeof x === "string") : null;
    return c.json({ allowlist: allow && allow.length ? allow : null });
  });
  app.put("/:id/llm-providers", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("org admin required to set the provider allowlist");
    const body = await c.req.json().catch(() => ({})) as { allowlist?: unknown };
    let allow: string[] | null = null;
    if (Array.isArray(body.allowlist)) {
      allow = body.allowlist.filter((x): x is string => typeof x === "string" && !!x.trim()).map(x => x.trim().toLowerCase()).slice(0, 20);
      if (!allow.length) allow = null;
    }
    await db.update(organizations).set({ llmProviderAllowlist: allow }).where(eq(organizations.id, orgId));
    await getAuditLog(db).record({
      repoId: null, actorKind: "human", actorId: payload.userId,
      action: "org.llm_providers.updated", category: "policy", metadata: { orgId, allowlist: allow },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, allowlist: allow });
  });

  // Per-repo health rollup for the org dashboard: open changes, the worst CI
  // status + highest risk among those open changes, and last activity. The repos
  // list previously surfaced only updatedAt — a fleet manager couldn't see which
  // repos need attention at a glance.
  app.get("/:id/repos-health", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const self = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId))).limit(1))[0];
    if (!self) throw new ForbiddenError("not a member of this org");
    const repos = await db.select({ id: repositories.id, name: repositories.name, updatedAt: repositories.updatedAt })
      .from(repositories).where(and(eq(repositories.namespaceType, "org"), eq(repositories.namespaceId, orgId))).limit(500);
    const repoIds = repos.map(r => r.id);
    const openChanges = repoIds.length
      ? await db.select({ repoId: changes.repoId, risk: changes.risk, computedRisk: changes.computedRisk, ciStatus: changes.ciStatus, updatedAt: changes.updatedAt })
          .from(changes).where(and(inArray(changes.repoId, repoIds), inArray(changes.status, ["pending", "approved", "changes_requested"])))
      : [];
    const RISK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    // "Worst" CI for the repo. skipped is as benign as success (no CI was needed),
    // so a single skipped change never masks a green one or reads as a problem.
    const CI: Record<string, number> = { skipped: 0, success: 0, pending: 1, running: 2, failure: 3 };
    type Agg = { openChanges: number; maxOpenRisk: string | null; ciStatus: string | null; lastActivity: Date | null };
    const byRepo = new Map<string, Agg>();
    for (const ch of openChanges) {
      const e = byRepo.get(ch.repoId) ?? { openChanges: 0, maxOpenRisk: null, ciStatus: null, lastActivity: null };
      e.openChanges++;
      const r = (ch.computedRisk as string | null) ?? ch.risk;
      if (r && (e.maxOpenRisk === null || (RISK[r] ?? 0) > (RISK[e.maxOpenRisk] ?? 0))) e.maxOpenRisk = r;
      if (ch.ciStatus && (e.ciStatus === null || (CI[ch.ciStatus] ?? -1) > (CI[e.ciStatus] ?? -1))) e.ciStatus = ch.ciStatus;
      if (ch.updatedAt && (!e.lastActivity || ch.updatedAt > e.lastActivity)) e.lastActivity = ch.updatedAt;
      byRepo.set(ch.repoId, e);
    }
    const out = repos.map(r => {
      const e = byRepo.get(r.id);
      return {
        id: r.id, name: r.name,
        openChanges: e?.openChanges ?? 0,
        maxOpenRisk: e?.maxOpenRisk ?? null,
        ciStatus: e?.ciStatus ?? null,
        lastActivity: e?.lastActivity ?? r.updatedAt,
      };
    }).sort((a, b) => b.openChanges - a.openChanges);
    return c.json({ repos: out });
  });

  app.post("/:id/members", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("only admins can add members");
    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: "admin" | "member" };
    if (!body.email) throw new ValidationError("email required");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") throw new ValidationError("role must be admin or member");
    // A service-kind account (gh-mirror / clawhub-system / per-agent owners) is
    // never a member a human adds — resolving one here is the #153 amplification
    // that led to a session as those namespaces. 404 like scim.ts.
    const user = (await db.select().from(users).where(and(eq(users.email, body.email.toLowerCase()), ne(users.kind, "service"))).limit(1))[0];
    if (!user) throw new NotFoundError("user");
    const role = body.role ?? "member";
    // A NEW membership is `admin_added` — NOT consent, so it can't authorize SSO
    // account resolution (#153). On conflict only the role changes; the existing
    // `source` is left untouched (a re-add never silently UPGRADES a stale row to
    // consent, and never downgrades a genuine invite_accepted/sso_jit row).
    await db.insert(orgMembers).values({ orgId, userId: user.id, role, source: "admin_added" })
      .onConflictDoUpdate({ target: [orgMembers.orgId, orgMembers.userId], set: { role } });
    await getAuditLog(db).record({
      actorKind: "human", actorId: payload.userId,
      action: "org.member_added", category: "admin",
      metadata: { orgId, targetUserId: user.id, role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role });
  });

  app.patch("/:id/members/:userId", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("only admins can change member roles");
    const body = await c.req.json().catch(() => ({})) as { role?: "admin" | "member" };
    if (body.role !== "admin" && body.role !== "member") throw new ValidationError("role must be admin or member");
    const target = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId))).limit(1))[0];
    if (!target) throw new NotFoundError("member");
    // Last-admin guard: don't let the org be left with zero admins by demoting
    // its only one (otherwise nobody can ever govern it again).
    if (target.role === "admin" && body.role === "member") {
      const otherAdmins = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin"), ne(orgMembers.userId, targetUserId))).limit(1))[0];
      if (!otherAdmins) throw new ForbiddenError("cannot demote the last admin");
    }
    await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId)));
    await getAuditLog(db).record({
      actorKind: "human", actorId: payload.userId,
      action: "org.member_role_changed", category: "admin",
      metadata: { orgId, targetUserId, fromRole: target.role, role: body.role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true, role: body.role });
  });

  app.delete("/:id/members/:userId", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const targetUserId = c.req.param("userId");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("only admins can remove members");
    const target = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId))).limit(1))[0];
    if (!target) throw new NotFoundError("member");
    // Last-admin guard: removing the only admin would orphan the org.
    if (target.role === "admin") {
      const otherAdmins = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "admin"), ne(orgMembers.userId, targetUserId))).limit(1))[0];
      if (!otherAdmins) throw new ForbiddenError("cannot remove the last admin");
    }
    await db.delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUserId)));
    await getAuditLog(db).record({
      actorKind: "human", actorId: payload.userId,
      action: "org.member_removed", category: "admin",
      metadata: { orgId, targetUserId, role: target.role },
      ip: ipFromContext(c), userAgent: userAgentFromContext(c),
    });
    return c.json({ ok: true });
  });

  return app;
}
