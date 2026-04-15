import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { hashPassword, signToken, verifyPassword } from "../services/auth.js";
import { AuthError, ConflictError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";

export function createUserRoutes(db: DB): Hono {
  const app = new Hono();

  app.post("/register", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string; name?: string };
    if (!body.email || !body.password) throw new ValidationError("email and password required");
    const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing[0]) throw new ConflictError("email already registered");
    const passwordHash = await hashPassword(body.password);
    const row = await db.insert(users).values({ email: body.email, name: body.name, passwordHash }).returning();
    const token = signToken({ kind: "user", userId: row[0].id, email: row[0].email });
    return c.json({ user: { id: row[0].id, email: row[0].email, name: row[0].name }, token }, 201);
  });

  app.post("/login", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string };
    if (!body.email || !body.password) throw new ValidationError("email and password required");
    const row = (await db.select().from(users).where(eq(users.email, body.email)).limit(1))[0];
    if (!row || !(await verifyPassword(body.password, row.passwordHash))) throw new AuthError("invalid credentials");
    const token = signToken({ kind: "user", userId: row.id, email: row.email });
    return c.json({ user: { id: row.id, email: row.email, name: row.name }, token });
  });

  const me = new Hono();
  me.use("*", authMiddleware);
  me.get("/me", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const row = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!row) throw new AuthError("user not found");
    return c.json({ id: row.id, email: row.email, name: row.name });
  });
  app.route("/", me);

  return app;
}
