import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { hashPassword, signToken, verifyPassword } from "../services/auth.js";
import { AuthError, ConflictError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";
import { isLockedOut, recordLoginAttempt } from "../services/auth-hardening.js";
import { verifyTotp } from "../services/totp.js";
import type { Context } from "hono";

// Best-effort client IP for the login-attempt audit record. Prefer Cloudflare's
// trusted CF-Connecting-IP (set by our edge), then the first X-Forwarded-For
// hop, then the socket. Lockout itself is keyed by EMAIL, not IP, so a spoofed
// IP cannot evade it — this value is only for the attempt log.
function clientIp(c: Context): string | null {
  return c.req.header("cf-connecting-ip")
    ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? null;
}

export function createUserRoutes(db: DB): Hono {
  const app = new Hono();

  app.post("/register", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string; name?: string };
    if (!body.email || !body.password) throw new ValidationError("email and password required");
    // Same normalization as the OAuth path — one address, one account,
    // regardless of how the user typed it or which provider sent it.
    const email = body.email.trim().toLowerCase();
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw new ConflictError("email already registered");
    const passwordHash = await hashPassword(body.password);
    const row = await db.insert(users).values({ email, name: body.name, passwordHash }).returning();
    const token = signToken({ kind: "user", userId: row[0].id, email: row[0].email, v: row[0].tokenVersion });
    return c.json({ user: { id: row[0].id, email: row[0].email, name: row[0].name }, token }, 201);
  });

  app.post("/login", async c => {
    const body = await c.req.json().catch(() => ({})) as { email?: string; password?: string; code?: string };
    if (!body.email || !body.password) throw new ValidationError("email and password required");
    const email = body.email.trim().toLowerCase();
    const ip = clientIp(c);

    // Brute-force lockout: after LOCKOUT_THRESHOLD consecutive failures in the
    // window (keyed by email), refuse without even checking the password. Don't
    // record this rejection so a locked-out attacker can't extend their own lock
    // indefinitely and lock the real user out forever.
    if ((await isLockedOut(db, email)).locked) {
      throw new AuthError("account temporarily locked after too many failed attempts; try again later");
    }

    const row = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
    // Service accounts (headless agent owners) can never sign in.
    const passwordOk = row && row.kind !== "service" && (await verifyPassword(body.password, row.passwordHash));
    if (!row || !passwordOk) {
      await recordLoginAttempt(db, email, ip, false);
      throw new AuthError("invalid credentials");
    }

    // Second factor. The password is correct; if TOTP is enabled require a valid
    // code. A missing code is NOT a failed attempt (the credential was right) —
    // signal the client to prompt for it. A wrong code IS a failed attempt.
    if (row.totpEnabled) {
      if (!body.code) return c.json({ error: "totp_required", totpRequired: true }, 401);
      if (!row.totpSecret || !verifyTotp(row.totpSecret, body.code)) {
        await recordLoginAttempt(db, email, ip, false);
        throw new AuthError("invalid 2fa code");
      }
    }

    await recordLoginAttempt(db, email, ip, true);
    const token = signToken({ kind: "user", userId: row.id, email: row.email, v: row.tokenVersion });
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
