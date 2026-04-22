import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, NotFoundError, ValidationError } from "../services/errors.js";
import { generateSecret, otpauthUrl, verifyTotp } from "../services/totp.js";

export function createTotpRoutes(db: DB): Hono {
  const app = new Hono();
  app.use("*", authMiddleware);

  app.post("/setup", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const user = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!user) throw new NotFoundError("user");
    if (user.totpEnabled) throw new ValidationError("totp already enabled");
    const secret = generateSecret();
    await db.update(users).set({ totpSecret: secret }).where(eq(users.id, user.id));
    return c.json({ secret, otpauth: otpauthUrl(user.email, "ClawHub", secret) });
  });

  app.post("/verify", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { code?: string };
    const user = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!user || !user.totpSecret) throw new ValidationError("no secret pending");
    if (!body.code || !verifyTotp(user.totpSecret, body.code)) throw new ValidationError("invalid code");
    await db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    return c.json({ ok: true });
  });

  app.post("/disable", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { code?: string };
    const user = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!user) throw new NotFoundError("user");
    if (user.totpEnabled && user.totpSecret) {
      if (!body.code || !verifyTotp(user.totpSecret, body.code)) throw new ValidationError("invalid code");
    }
    await db.update(users).set({ totpEnabled: false, totpSecret: null }).where(eq(users.id, user.id));
    return c.json({ ok: true });
  });

  return app;
}
