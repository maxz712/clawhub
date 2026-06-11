import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { emailVerifications, users } from "../models/schema.js";
import { consumeEmailVerification, consumePasswordReset, issueEmailVerification, issuePasswordReset, queueTransactionalEmail } from "../services/auth-hardening.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";

export function createAccountRoutes(db: DB, publicBaseUrl: string): Hono {
  const app = new Hono();

  // All endpoints are public (no JWT required).
  app.post("/password/reset/request", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string };
    if (!body.email) throw new ValidationError("email required");
    const { user, token } = await issuePasswordReset(db, body.email);
    if (user && token) {
      const url = `${publicBaseUrl.replace(/\/+$/, "")}/reset/${token}`;
      await queueTransactionalEmail(db, user.id, "Reset your ClawHub password", `<p>Reset link (expires in 30 minutes):</p><p><a href="${url}">${url}</a></p>`);
    }
    // Always 200 to avoid email enumeration.
    return c.json({ ok: true });
  });

  app.post("/password/reset/consume", async c => {
    const body = await c.req.json().catch(() => ({})) as { token?: string; newPassword?: string };
    if (!body.token || !body.newPassword) throw new ValidationError("token + newPassword required");
    if (body.newPassword.length < 10) throw new ValidationError("password too short");
    const ok = await consumePasswordReset(db, body.token, body.newPassword);
    return c.json({ ok });
  });

  app.post("/email/verify/request", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string };
    if (!body.email) throw new ValidationError("email required");
    const user = (await db.select().from(users).where(eq(users.email, body.email)).limit(1))[0];
    if (user) {
      const token = await issueEmailVerification(db, user.id);
      const url = `${publicBaseUrl.replace(/\/+$/, "")}/verify-email/${token}`;
      await queueTransactionalEmail(db, user.id, "Verify your email for ClawHub", `<p>Click to verify:</p><p><a href="${url}">${url}</a></p>`);
    }
    return c.json({ ok: true });
  });

  app.post("/email/verify/consume", async c => {
    const body = await c.req.json().catch(() => ({})) as { token?: string };
    if (!body.token) throw new ValidationError("token required");
    const userId = await consumeEmailVerification(db, body.token);
    return c.json({ ok: !!userId, userId });
  });

  // Authenticated: end every session for the calling user by bumping the
  // token version — outstanding JWTs stop verifying within the token-cache
  // TTL. The caller's own token dies too; they sign in again for a new one.
  const authed = new Hono();
  authed.use("*", authMiddleware);
  authed.post("/sessions/revoke-all", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const row = (await db.update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, p.userId))
      .returning({ tokenVersion: users.tokenVersion }))[0];
    if (!row) throw new AuthError("user not found");
    return c.json({ ok: true });
  });
  app.route("/", authed);

  return app;
}
