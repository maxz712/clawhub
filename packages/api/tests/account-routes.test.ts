import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { emailOutbox, users } from "../src/models/schema.js";
import { createAccountRoutes } from "../src/routes/account.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { hashPassword, signToken } from "../src/services/auth.js";
import type { DB } from "../src/models/db.js";
import type { GitService } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-account-routes";
// The composed-app tests below hit the tight per-IP auth bucket (login +
// account recovery share it) more than 5 times in a minute — raise the cap so
// the suite exercises the routes, not the limiter.
process.env.CLAWHUB_AUTH_RATE_LIMIT = "1000";

// Regression coverage for #101: /api/v1/account was mounted AFTER four routers
// that install use("*", authMiddleware) at the bare /api/v1 prefix, which Hono
// registers as wildcard middleware over ALL of /api/v1 — so every "public"
// account-recovery endpoint 401'd in production and a user who forgot their
// password was permanently locked out. The router is now split pub/auth and the
// pub half mounts in the genuinely-public block.

// ---------------------------------------------------------------------------
// Router-level: the auth half must gate ITSELF. Before the split, DELETE /
// read tokenPayload without installing authMiddleware — it only worked because
// unrelated wildcard middleware happened to authenticate the request first.
// These short-circuit before any DB work, so a stub DB suffices.
// ---------------------------------------------------------------------------
function authHalfApp(): Hono {
  const app = new Hono();
  app.route("/api/v1/account", createAccountRoutes({} as DB, {} as GitService, "https://example.test").auth);
  app.onError(errorHandler);
  return app;
}

describe("account auth half gates itself (no wildcard dependency)", () => {
  it("DELETE /api/v1/account without a token → 401, not a tokenPayload-undefined 500", async () => {
    const res = await authHalfApp().request("/api/v1/account", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE /api/v1/account with an AGENT token → 401 users only", async () => {
    const token = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const res = await authHalfApp().request("/api/v1/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /sessions/revoke-all without a token → 401", async () => {
    const res = await authHalfApp().request("/api/v1/account/sessions/revoke-all", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// App-level: the mount-order bug is invisible to router-level tests, so these
// run against the REAL buildApp (every wildcard-auth router mounted) with NO
// Authorization header. Needs a migrated Postgres → skipIf, test-db.ts style.
// ---------------------------------------------------------------------------
describe.skipIf(!hasTestDb)("account recovery through the composed app (#101)", () => {
  const S = Date.now();
  const email = `acct-${S}@t.co`;
  const originalPassword = "original-password-1";
  const newPassword = "brand-new-password-2";
  let app: Hono;
  let userId: string;

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** Newest outbox email for our user; token extracted from the link path. */
  async function latestOutboxToken(pathPrefix: string): Promise<string> {
    const row = (await db.select().from(emailOutbox)
      .where(eq(emailOutbox.toEmail, email))
      .orderBy(desc(emailOutbox.createdAt)).limit(1))[0];
    expect(row, "expected a queued email in email_outbox").toBeTruthy();
    const m = row!.body.match(new RegExp(`${pathPrefix}/([A-Za-z0-9_-]+)`));
    expect(m, `expected a ${pathPrefix} link in the email body`).toBeTruthy();
    return m![1];
  }

  beforeAll(async () => {
    const { buildApp } = await import("../src/app.js");
    const { GitService } = await import("../src/services/git.js");
    const { EventBus } = await import("../src/services/events.js");
    const base = await mkdtemp(join(tmpdir(), "clawhub-account-test-"));
    app = buildApp({ db, git: new GitService(base), events: new EventBus(), inProcessWorker: false });
    const [u] = await db.insert(users).values({
      email, username: `acct${S}`, passwordHash: await hashPassword(originalPassword),
    }).returning();
    userId = u.id;
  });

  it("password reset request is reachable with NO token (unknown email → enumeration-safe 200)", async () => {
    const res = await post("/api/v1/account/password/reset/request", { email: "nobody@example.invalid" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("full logged-out reset flow: request → emailed token → consume → login with the new password", async () => {
    const req = await post("/api/v1/account/password/reset/request", { email });
    expect(req.status).toBe(200);

    const token = await latestOutboxToken("/reset");
    const consume = await post("/api/v1/account/password/reset/consume", { token, newPassword });
    expect(consume.status).toBe(200);
    expect((await consume.json()).ok).toBe(true);

    const oldLogin = await post("/api/v1/users/login", { email, password: originalPassword });
    expect(oldLogin.status).toBe(401);
    const login = await post("/api/v1/users/login", { email, password: newPassword });
    expect(login.status).toBe(200);
    expect((await login.json()).token).toBeTruthy();
  });

  it("consume with a bogus token → 200 {ok:false}, never a 401", async () => {
    const res = await post("/api/v1/account/password/reset/consume", { token: "not-a-real-token", newPassword });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });

  it("email verification request + consume are reachable with NO token", async () => {
    const req = await post("/api/v1/account/email/verify/request", { email });
    expect(req.status).toBe(200);

    const token = await latestOutboxToken("/verify-email");
    const consume = await post("/api/v1/account/email/verify/consume", { token });
    expect(consume.status).toBe(200);
    const body = await consume.json();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(userId);
  });

  it("DELETE /api/v1/account through the composed app still requires a user token", async () => {
    const anon = await app.request("/api/v1/account", { method: "DELETE" });
    expect(anon.status).toBe(401);

    const agentTok = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const agent = await app.request("/api/v1/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${agentTok}`, "content-type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
    expect(agent.status).toBe(401);
  });

  it("sessions/revoke-all works with a user token and bumps token_version", async () => {
    // Token-version revocation runs on verify (token-cache), so mint at the
    // CURRENT version — the reset consume above already bumped it once.
    const before = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    const tok = signToken({ kind: "user", userId, email, v: before.tokenVersion });
    const res = await post("/api/v1/account/sessions/revoke-all", {}, { authorization: `Bearer ${tok}` });
    expect(res.status).toBe(200);
    const after = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
  });
});
