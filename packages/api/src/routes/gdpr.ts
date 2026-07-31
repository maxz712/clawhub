import { Hono } from "hono";
import type { DB } from "../models/db.js";
import { authMiddleware } from "../middleware/auth.js";
import { AuthError, ValidationError } from "../services/errors.js";
import { queueTransactionalEmail } from "../services/auth-hardening.js";
import {
  confirmDeletion, getRequest, issueDeletionConfirmation, requestDeletion, requestExport, requirePasswordReauth,
} from "../services/gdpr.js";

// Split router, account.ts-style (#101 pattern): `pub` carries the tokenless
// delete-confirmation consume (the emailed link must work logged-out — the
// token itself is the proof: single-use, sha256-at-rest, 30-min TTL, issued
// only by an authenticated request); `auth` carries everything else behind its
// own explicit authMiddleware.
export function createGdprRoutes(db: DB, publicBaseUrl: string): { pub: Hono; auth: Hono } {
  const pub = new Hono();

  pub.post("/delete/confirm", async c => {
    const body = await c.req.json().catch(() => ({})) as { token?: string };
    if (!body.token) throw new ValidationError("token required");
    const requestId = await confirmDeletion(db, body.token);
    // Bad/expired/reused token → {ok:false}, matching the password-reset
    // consume contract (fail closed, no enumeration).
    return c.json(requestId ? { ok: true, requestId } : { ok: false });
  });

  const auth = new Hono();
  auth.use("*", authMiddleware);

  auth.post("/export", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const id = await requestExport(db, p.userId);
    return c.json({ requestId: id });
  });

  // #103: the deletion cascade must never run off a bare bearer token — the
  // same property #37 gave DELETE /api/v1/account. Password holders re-auth
  // inline; OAuth-only accounts (unguessable random password) keep their
  // erasure right via an emailed single-use confirmation token.
  auth.post("/delete", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const body = await c.req.json().catch(() => ({})) as { password?: string; method?: string };
    if (body.password) {
      await requirePasswordReauth(db, p.userId, body.password);
      const id = await requestDeletion(db, p.userId);
      return c.json({ requestId: id, method: "password" });
    }
    if (body.method === "email") {
      const { requestId, token } = await issueDeletionConfirmation(db, p.userId);
      const url = `${publicBaseUrl.replace(/\/+$/, "")}/delete-account/${token}`;
      await queueTransactionalEmail(db, p.userId, "Confirm ClawHub account deletion",
        `<p>Someone (hopefully you) requested permanent deletion of your ClawHub account.</p><p>Nothing has been deleted yet. To confirm, open this link (expires in 30 minutes):</p><p><a href="${url}">${url}</a></p><p>If you did not request this, ignore this email and consider revoking your sessions.</p>`);
      return c.json({ requestId, method: "email" });
    }
    throw new ValidationError("password required (or method:'email' to confirm deletion via the account email)");
  });

  auth.get("/requests/:id", async c => {
    const p = c.get("tokenPayload");
    if (p.kind !== "user") throw new AuthError("users only");
    const r = await getRequest(db, c.req.param("id"), p.userId);
    if (!r) return c.json({ error: "not_found" }, 404);
    const { tokenHash: _tokenHash, ...safe } = r;
    return c.json({ request: safe });
  });

  return { pub, auth };
}
