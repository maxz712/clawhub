import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { emailOutbox, gdprRequests, users } from "../src/models/schema.js";
import { createGdprRoutes } from "../src/routes/gdpr.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { hashPassword, signToken } from "../src/services/auth.js";
import { issueDeletionConfirmation } from "../src/services/gdpr.js";
import type { DB } from "../src/models/db.js";
import type { GitService as GitServiceType } from "../src/services/git.js";

process.env.JWT_SECRET ??= "test-secret-gdpr-routes";
process.env.CLAWHUB_AUTH_RATE_LIMIT = "1000";

// Regression coverage for #103: POST /api/v1/gdpr/delete ran the full account
// deletion cascade off nothing but a valid user bearer token — silently
// bypassing the #37 password gate on DELETE /api/v1/account. The route is now
// re-auth gated: password holders confirm inline; passwordless (OAuth-only)
// accounts get an emailed single-use confirmation token, consumed atomically.

// ---------------------------------------------------------------------------
// Router-level: the auth half must gate ITSELF (the #101 lesson — never depend
// on an unrelated wildcard authMiddleware). Short-circuits before DB work.
// ---------------------------------------------------------------------------
function gdprApp(): Hono {
  const app = new Hono();
  const gdpr = createGdprRoutes({} as DB, {} as GitServiceType, "https://example.test");
  app.route("/api/v1/gdpr", gdpr.pub);
  app.route("/api/v1/gdpr", gdpr.auth);
  app.onError(errorHandler);
  return app;
}

describe("gdpr auth half gates itself", () => {
  it("POST /delete without a token → 401", async () => {
    const res = await gdprApp().request("/api/v1/gdpr/delete", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /delete with an AGENT token → 401 users only", async () => {
    const token = signToken({ kind: "agent", agentId: "a1", name: "bot" });
    const res = await gdprApp().request("/api/v1/gdpr/delete", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("POST /delete/confirm without a token in the body → 400", async () => {
    const res = await gdprApp().request("/api/v1/gdpr/delete/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// App-level: the real buildApp (wildcard-auth routers mounted), real Postgres.
// ---------------------------------------------------------------------------
describe.skipIf(!hasTestDb)("gdpr deletion gate through the composed app (#103)", () => {
  const S = Date.now();
  const password = "correct-horse-battery-1";
  let app: Hono;

  async function makeUser(tag: string, withPassword = true) {
    const email = `gdpr-${tag}-${S}@t.co`;
    const [u] = await db.insert(users).values({
      email, username: `gdpr${tag}${S}`,
      passwordHash: await hashPassword(withPassword ? password : `random-${S}-${tag}-unguessable`),
    }).returning();
    const token = signToken({ kind: "user", userId: u.id, email, v: u.tokenVersion });
    return { user: u, token };
  }

  async function post(path: string, body: unknown, token?: string) {
    return app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  async function userExists(id: string): Promise<boolean> {
    return !!(await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1))[0];
  }

  /** The cascade runs detached — poll until the row is gone (or time out). */
  async function waitUserDeleted(id: string): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (!(await userExists(id))) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }

  async function latestOutboxToken(email: string): Promise<string> {
    const row = (await db.select().from(emailOutbox)
      .where(eq(emailOutbox.toEmail, email))
      .orderBy(desc(emailOutbox.createdAt)).limit(1))[0];
    expect(row, "expected a queued email in email_outbox").toBeTruthy();
    const m = row!.body.match(/\/delete-account\/([A-Za-z0-9_-]+)/);
    expect(m, "expected a /delete-account link in the email body").toBeTruthy();
    return m![1];
  }

  beforeAll(async () => {
    const { buildApp } = await import("../src/app.js");
    const { GitService } = await import("../src/services/git.js");
    const { EventBus } = await import("../src/services/events.js");
    const base = await mkdtemp(join(tmpdir(), "clawhub-gdpr-test-"));
    app = buildApp({ db, git: new GitService(base), events: new EventBus(), inProcessWorker: false });
  });

  it("bearer token alone (empty body) does NOT delete — 400, user survives", async () => {
    const { user, token } = await makeUser("bare");
    const res = await post("/api/v1/gdpr/delete", {}, token);
    expect(res.status).toBe(400);
    await new Promise(r => setTimeout(r, 300));
    expect(await userExists(user.id)).toBe(true);
  });

  it("wrong password → 401, user survives", async () => {
    const { user, token } = await makeUser("wrongpw");
    const res = await post("/api/v1/gdpr/delete", { password: "not-the-password" }, token);
    expect(res.status).toBe(401);
    await new Promise(r => setTimeout(r, 300));
    expect(await userExists(user.id)).toBe(true);
  });

  it("correct password → cascade runs, user deleted, notification email queued", async () => {
    const { user, token } = await makeUser("pw");
    const res = await post("/api/v1/gdpr/delete", { password }, token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.method).toBe("password");
    expect(await waitUserDeleted(user.id)).toBe(true);
    const mail = (await db.select().from(emailOutbox)
      .where(eq(emailOutbox.toEmail, user.email))
      .orderBy(desc(emailOutbox.createdAt)).limit(1))[0];
    expect(mail?.subject).toContain("deleted");
  });

  it("passwordless path: request → nothing deleted → emailed token confirms end-to-end", async () => {
    const { user, token } = await makeUser("oauth", false);
    const res = await post("/api/v1/gdpr/delete", { method: "email" }, token);
    expect(res.status).toBe(200);
    expect((await res.json()).method).toBe("email");
    // Requesting the email must not delete anything.
    await new Promise(r => setTimeout(r, 300));
    expect(await userExists(user.id)).toBe(true);

    const raw = await latestOutboxToken(user.email);

    // Tampered token fails closed, no auth required (public consume).
    const bad = await post("/api/v1/gdpr/delete/confirm", { token: raw + "x" });
    expect(bad.status).toBe(200);
    expect((await bad.json()).ok).toBe(false);
    expect(await userExists(user.id)).toBe(true);

    // Real token consumes and the cascade runs.
    const ok = await post("/api/v1/gdpr/delete/confirm", { token: raw });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ok).toBe(true);
    expect(await waitUserDeleted(user.id)).toBe(true);

    // Single-use: replaying the same token fails closed.
    const replay = await post("/api/v1/gdpr/delete/confirm", { token: raw });
    expect((await replay.json()).ok).toBe(false);
  });

  it("expired confirmation token fails closed", async () => {
    const { user } = await makeUser("expired", false);
    const raw = "expired-token-raw-value";
    await db.insert(gdprRequests).values({
      userId: user.id, kind: "delete", status: "awaiting_confirm",
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await post("/api/v1/gdpr/delete/confirm", { token: raw });
    expect((await res.json()).ok).toBe(false);
    await new Promise(r => setTimeout(r, 300));
    expect(await userExists(user.id)).toBe(true);
  });

  it("two concurrent consumes → exactly one wins (atomic claim)", async () => {
    const { user } = await makeUser("race", false);
    const { token: raw } = await issueDeletionConfirmation(db, user.id);
    const [a, b] = await Promise.all([
      post("/api/v1/gdpr/delete/confirm", { token: raw }),
      post("/api/v1/gdpr/delete/confirm", { token: raw }),
    ]);
    const oks = [(await a.json()).ok, (await b.json()).ok];
    expect(oks.filter(Boolean).length).toBe(1);
    expect(await waitUserDeleted(user.id)).toBe(true);
  });

  it("GET /requests/:id never returns the token hash", async () => {
    const { user, token } = await makeUser("redact", false);
    const res = await post("/api/v1/gdpr/delete", { method: "email" }, token);
    const { requestId } = await res.json();
    const get = await app.request(`/api/v1/gdpr/requests/${requestId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.status).toBe(200);
    const body = await get.json();
    expect(body.request.tokenHash).toBeUndefined();
  });
});
