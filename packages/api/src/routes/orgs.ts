import { Hono } from "hono";
import { and, eq, ne } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, organizations, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";
import { getAuditLog, ipFromContext, userAgentFromContext } from "../services/audit.js";

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

  app.post("/:id/members", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("only admins can add members");
    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: "admin" | "member" };
    if (!body.email) throw new ValidationError("email required");
    if (body.role !== undefined && body.role !== "admin" && body.role !== "member") throw new ValidationError("role must be admin or member");
    const user = (await db.select().from(users).where(eq(users.email, body.email.toLowerCase())).limit(1))[0];
    if (!user) throw new NotFoundError("user");
    const role = body.role ?? "member";
    await db.insert(orgMembers).values({ orgId, userId: user.id, role })
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
