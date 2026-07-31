import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type { DB } from "../models/db.js";
import type { GitService } from "../services/git.js";
import { requestDeletion, requirePasswordReauth } from "../services/gdpr.js";
import { users } from "../models/schema.js";
import { consumeEmailVerification, consumePasswordReset, issueEmailVerification, issuePasswordReset, queueTransactionalEmail } from "../services/auth-hardening.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { authMiddleware } from "../middleware/auth.js";

// Split router, marketplace/billing/status-style: `pub` is the genuinely
// tokenless account-recovery surface (a logged-out user must reach it — mount
// BEFORE any bare-/api/v1 router that installs use("*", authMiddleware), which
// Hono registers as wildcard middleware over ALL of /api/v1); `auth` carries
// its own explicit authMiddleware so it never depends on an unrelated router's
// wildcard happening to authenticate the request first.
export function createAccountRoutes(db: DB, git: GitService, publicBaseUrl: string): { pub: Hono; auth: Hono } {
  const pub = new Hono();

  pub.post("/password/reset/request", async c => {
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

  pub.post("/password/reset/consume", async c => {
    const body = await c.req.json().catch(() => ({})) as { token?: string; newPassword?: string };
    if (!body.token || !body.newPassword) throw new ValidationError("token + newPassword required");
    if (body.newPassword.length < 10) throw new ValidationError("password too short");
    const ok = await consumePasswordReset(db, body.token, body.newPassword);
    return c.json({ ok });
  });

  pub.post("/email/verify/request", async c => {
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

  pub.post("/email/verify/consume", async c => {
    const body = await c.req.json().catch(() => ({})) as { token?: string };
    if (!body.token) throw new ValidationError("token required");
    const userId = await consumeEmailVerification(db, body.token);
    return c.json({ ok: !!userId, userId });
  });

  const auth = new Hono();
  auth.use("*", authMiddleware);

  // #37: account self-deletion. Password-gated (a stolen bearer token alone
  // must not be able to erase the account), then delegated to the GDPR deletion
  // service — the ONE audited cascade path (agents, keys, workflows, memories;
  // billing rows keep amounts with personal attribution scrubbed). Returns the
  // gdpr_requests id so the caller can poll completion.
  auth.delete("/", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { password?: string };
    if (!body.password) throw new ValidationError("password required to delete the account");
    // Shared with POST /api/v1/gdpr/delete (#103) so the two doors into the
    // deletion cascade can never drift apart again.
    await requirePasswordReauth(db, p.userId, body.password);
    const requestId = await requestDeletion(db, git, p.userId);
    return c.json({ ok: true, requestId });
  });

  // End every session for the calling user by bumping the token version —
  // outstanding JWTs stop verifying within the token-cache TTL. The caller's
  // own token dies too; they sign in again for a new one.
  auth.post("/sessions/revoke-all", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("user token required");
    const row = (await db.update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, p.userId))
      .returning({ tokenVersion: users.tokenVersion }))[0];
    if (!row) throw new AuthError("user not found");
    return c.json({ ok: true });
  });

  return { pub, auth };
}
