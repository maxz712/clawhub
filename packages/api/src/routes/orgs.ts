import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { orgMembers, organizations, users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors.js";

export function createOrgRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const body = await c.req.json().catch(() => ({})) as { name?: string; displayName?: string };
    if (!body.name) throw new ValidationError("name required");
    const existing = await db.select().from(organizations).where(eq(organizations.name, body.name)).limit(1);
    if (existing[0]) throw new ConflictError("name taken");
    const row = (await db.insert(organizations).values({ name: body.name, displayName: body.displayName }).returning())[0];
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

  app.post("/:id/members", async c => {
    const payload = c.get("tokenPayload");
    if (payload.kind !== "user") throw new AuthError("user token required");
    const orgId = c.req.param("id");
    const admin = (await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, payload.userId), eq(orgMembers.role, "admin"))).limit(1))[0];
    if (!admin) throw new ForbiddenError("only admins can add members");
    const body = await c.req.json().catch(() => ({})) as { email?: string; role?: "admin" | "member" };
    if (!body.email) throw new ValidationError("email required");
    const user = (await db.select().from(users).where(eq(users.email, body.email)).limit(1))[0];
    if (!user) throw new NotFoundError("user");
    await db.insert(orgMembers).values({ orgId, userId: user.id, role: body.role ?? "member" })
      .onConflictDoNothing();
    return c.json({ ok: true });
  });

  return app;
}
