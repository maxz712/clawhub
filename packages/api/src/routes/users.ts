import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "../models/db.js";
import { users } from "../models/schema.js";
import { hashPassword, signToken, verifyPassword } from "../services/auth.js";
import { AuthError, ConflictError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";
import { isLockedOut, recordLoginAttempt } from "../services/auth-hardening.js";
import { verifyAndConsumeTotp } from "../services/totp.js";
import { ensureUserHandle } from "../services/namespace.js";
import { CURRENT_TERMS_VERSION } from "../services/legal.js";
import { getAuditLog, userAgentFromContext } from "../services/audit.js";
import { ensurePersonalAgentInBackground } from "../services/personal-agent.js";
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
    // Enforce the same minimum length as the password-reset path so a freshly
    // registered password can't be weaker than one set via reset.
    if (body.password.length < 10) throw new ValidationError("password too short");
    // Same normalization as the OAuth path — one address, one account,
    // regardless of how the user typed it or which provider sent it.
    const email = body.email.trim().toLowerCase();
    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing[0]) throw new ConflictError("email already registered");
    const passwordHash = await hashPassword(body.password);
    // Record the Terms version accepted at register (M3 legal). The dashboard
    // gates the submit on the acceptance checkbox; this is the durable record.
    const row = await db.insert(users).values({ email, name: body.name, passwordHash, termsVersion: CURRENT_TERMS_VERSION }).returning();
    // Give the new account a resolvable handle up front — it's the namespace a
    // human pushes their own code under, so onboarding (`ch init` → `git push`)
    // works in one step.
    const username = await ensureUserHandle(db, row[0].id, row[0].email);
    void getAuditLog(db).record({
      actorKind: "human", actorId: row[0].id, actorHandle: username,
      action: "user.registered", category: "auth",
      ip: clientIp(c), userAgent: userAgentFromContext(c),
    });
    // v3: every new user gets ONE default personal agent — DORMANT (no
    // workflow, zero runs, zero spend) with the Developer role. It doubles as
    // their wrapper identity and is one click from deployment.
    ensurePersonalAgentInBackground(db, row[0].id, username ?? email);
    const token = signToken({ kind: "user", userId: row[0].id, email: row[0].email, v: row[0].tokenVersion });
    return c.json({ user: { id: row[0].id, email: row[0].email, name: row[0].name, username }, token }, 201);
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
    // Service accounts (headless agent owners) can never sign in. Neither can a
    // DEPROVISIONED account (#133, users.disabled_at — SCIM `active:false`):
    // folded into the same predicate so a deactivated employee gets the generic
    // "invalid credentials" and the response never distinguishes "disabled" from
    // "wrong password" to an outsider probing addresses.
    const passwordOk = row && row.kind !== "service" && !row.disabledAt
      && (await verifyPassword(body.password, row.passwordHash));
    if (!row || !passwordOk) {
      await recordLoginAttempt(db, email, ip, false);
      throw new AuthError("invalid credentials");
    }

    // Second factor. The password is correct; if TOTP is enabled require a valid
    // code. A missing code is NOT a failed attempt (the credential was right) —
    // signal the client to prompt for it. A wrong code IS a failed attempt.
    if (row.totpEnabled) {
      if (!body.code) return c.json({ error: "totp_required", totpRequired: true }, 401);
      if (!row.totpSecret || !(await verifyAndConsumeTotp(db, row, body.code))) {
        await recordLoginAttempt(db, email, ip, false);
        throw new AuthError("invalid 2fa code");
      }
    }

    await recordLoginAttempt(db, email, ip, true);
    // row already carries username — pass it so ensureUserHandle skips a re-SELECT.
    const username = await ensureUserHandle(db, row.id, row.email, row.username);
    // Login events are private to the USER (v3 unified audit) — repoId null,
    // surfaced only on their own audit view, never an org boundary.
    void getAuditLog(db).record({
      actorKind: "human", actorId: row.id, actorHandle: username,
      action: "user.login", category: "auth",
      ip, userAgent: userAgentFromContext(c),
    });
    const token = signToken({ kind: "user", userId: row.id, email: row.email, v: row.tokenVersion });
    return c.json({ user: { id: row.id, email: row.email, name: row.name, username }, token });
  });

  const me = new Hono();
  me.use("*", authMiddleware);
  me.get("/me", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const row = (await db.select().from(users).where(eq(users.id, p.userId)).limit(1))[0];
    if (!row) throw new AuthError("user not found");
    // Ensure a handle exists for accounts created before handles were minted at
    // register/login, so the CLI can always resolve the push namespace.
    const username = row.username ?? await ensureUserHandle(db, row.id, row.email, null);
    // termsCurrent drives the dashboard's re-acceptance banner (M3).
    // totpEnabled lets account settings show the right 2FA action (not both).
    return c.json({ id: row.id, email: row.email, name: row.name, username, termsVersion: row.termsVersion, termsCurrent: row.termsVersion >= CURRENT_TERMS_VERSION, totpEnabled: !!row.totpEnabled });
  });
  // Record acceptance of the current Terms (from the re-acceptance banner, M3).
  me.post("/me/accept-terms", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    await db.update(users).set({ termsVersion: CURRENT_TERMS_VERSION }).where(eq(users.id, p.userId));
    return c.json({ ok: true, termsVersion: CURRENT_TERMS_VERSION });
  });
  app.route("/", me);

  return app;
}
