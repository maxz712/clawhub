import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq, inArray, like } from "drizzle-orm";

// `routes/admin.ts` snapshots CLAWHUB_ADMIN_EMAILS into a module-level Set at
// import time, so the allowlist MUST exist before the import graph is
// evaluated. vi.hoisted runs ahead of the (hoisted) imports below.
const { ADMIN_EMAIL } = vi.hoisted(() => {
  const email = "status-admin@clawhub.test";
  process.env.CLAWHUB_ADMIN_EMAILS = email;
  process.env.JWT_SECRET ??= "test-secret-status-admin";
  return { ADMIN_EMAIL: email };
});

import { hasTestDb, testDb } from "./test-db.js";
import { createStatusRoutes } from "../src/routes/status.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { signToken } from "../src/services/auth.js";
import { auditEvents, statusIncidents } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

// #126: /api/v1/status is mounted behind authMiddleware only — AUTHENTICATION,
// not authorization. Both writes used to stop at `kind !== "user"`, so any
// signed-up user could fabricate a public outage (POST /) or silently resolve
// the operator's real one (POST /:id/resolve, unscoped by id). The writes are
// now platform-admin gated like flags.ts / attestations.ts / security.ts.

function buildApp(db: DB): Hono {
  const { pub, admin } = createStatusRoutes(db);
  const app = new Hono();
  app.route("/api/v1/public/status", pub);
  app.route("/api/v1/status", admin);
  app.onError(errorHandler);
  return app;
}

// audit_events.actor_id is a uuid column — a non-UUID id would make the
// fire-and-forget audit insert fail silently, so the fixtures use real UUIDs.
const ADMIN_USER_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const adminToken = () => signToken({ kind: "user", userId: ADMIN_USER_ID, email: ADMIN_EMAIL });
const plainToken = () => signToken({ kind: "user", userId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", email: "nobody@clawhub.test" });
const agentToken = () => signToken({ kind: "agent", agentId: "a1", name: "bot" });

function post(app: Hono, path: string, token: string | null, body?: unknown) {
  return app.request(path, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

const SOME_UUID = "11111111-2222-3333-4444-555555555555";

describe("#126 status writes are platform-admin gated (no DB)", () => {
  // Every case below is rejected before any DB work, so a fake DB suffices —
  // which is also the proof that nothing reached the table.
  const app = buildApp({} as DB);

  it("401 without a token", async () => {
    expect((await post(app, "/api/v1/status", null, { title: "t", body: "b" })).status).toBe(401);
    expect((await post(app, `/api/v1/status/${SOME_UUID}/resolve`, null)).status).toBe(401);
  });

  it("401 not_admin for an ordinary authenticated user on BOTH writes", async () => {
    const create = await post(app, "/api/v1/status", plainToken(), { title: "All services down", body: "x", severity: "critical" });
    expect(create.status).toBe(401);
    expect((await create.json()).message).toBe("not_admin");

    const resolve = await post(app, `/api/v1/status/${SOME_UUID}/resolve`, plainToken());
    expect(resolve.status).toBe(401);
    expect((await resolve.json()).message).toBe("not_admin");
  });

  it("401 users only for an agent token", async () => {
    const res = await post(app, "/api/v1/status", agentToken(), { title: "t", body: "b" });
    expect(res.status).toBe(401);
    expect((await res.json()).message).toBe("users only");
  });

  it("400 on an out-of-band severity even for an admin — it would land in the public overall field", async () => {
    for (const severity of ["catastrophic", "MINOR", "", "operational"]) {
      const res = await post(app, "/api/v1/status", adminToken(), { title: "t", body: "b", severity });
      expect(res.status, `severity=${severity}`).toBe(400);
    }
  });

  it("400 when title or body is missing", async () => {
    expect((await post(app, "/api/v1/status", adminToken(), { body: "b" })).status).toBe(400);
    expect((await post(app, "/api/v1/status", adminToken(), { title: "  ", body: "b" })).status).toBe(400);
  });

  it("404 on a non-UUID incident id instead of a 500 from Postgres", async () => {
    expect((await post(app, "/api/v1/status/not-a-uuid/resolve", adminToken())).status).toBe(404);
  });
});

describe.skipIf(!hasTestDb)("#126 admin status writes (db)", () => {
  const app = buildApp(testDb);
  const TITLE_PREFIX = `status126-${Math.random().toString(36).slice(2, 8)}`;
  const created: string[] = [];

  beforeAll(async () => {
    // The public payload is instance-wide; make sure a leftover active incident
    // from another run can't decide this suite's assertions.
    await testDb.update(statusIncidents)
      .set({ resolvedAt: new Date(), status: "resolved" })
      .where(eq(statusIncidents.status, "investigating"));
  });

  afterAll(async () => {
    if (created.length) await testDb.delete(statusIncidents).where(inArray(statusIncidents.id, created));
    await testDb.delete(auditEvents).where(like(auditEvents.action, "status.incident.%"));
  });

  it("admin files an incident, it surfaces on the UNAUTHENTICATED public page, then resolves", async () => {
    const create = await post(app, "/api/v1/status", adminToken(), {
      title: `${TITLE_PREFIX} degraded git tier`, body: "Pushes are slow.", severity: "major",
    });
    expect(create.status).toBe(201);
    const { incident } = await create.json();
    created.push(incident.id);
    expect(incident.severity).toBe("major");

    // Criterion 5: public GET stays unauthenticated with an unchanged shape.
    const pubRes = await app.request("/api/v1/public/status");
    expect(pubRes.status).toBe(200);
    const pub = await pubRes.json();
    expect(pub.overall).toBe("major");
    expect(pub.active.map((i: { id: string }) => i.id)).toContain(incident.id);
    expect(pub.recent.map((i: { id: string }) => i.id)).toContain(incident.id);

    const resolve = await post(app, `/api/v1/status/${incident.id}/resolve`, adminToken());
    expect(resolve.status).toBe(200);

    const after = await (await app.request("/api/v1/public/status")).json();
    expect(after.overall).toBe("operational");
    expect(after.active.map((i: { id: string }) => i.id)).not.toContain(incident.id);
  });

  it("a non-admin cannot resolve a REAL operator incident", async () => {
    const create = await post(app, "/api/v1/status", adminToken(), {
      title: `${TITLE_PREFIX} real outage`, body: "Operator filed.", severity: "critical",
    });
    const { incident } = await create.json();
    created.push(incident.id);

    const res = await post(app, `/api/v1/status/${incident.id}/resolve`, plainToken());
    expect(res.status).toBe(401);

    const [row] = await testDb.select().from(statusIncidents).where(eq(statusIncidents.id, incident.id));
    expect(row.resolvedAt).toBeNull();
    expect(row.status).toBe("investigating");

    await post(app, `/api/v1/status/${incident.id}/resolve`, adminToken());
  });

  it("404 on an unknown incident id — no silent {ok:true} no-op", async () => {
    const res = await post(app, `/api/v1/status/${SOME_UUID}/resolve`, adminToken());
    expect(res.status).toBe(404);
  });

  it("both writes are attributable in the audit log", async () => {
    const create = await post(app, "/api/v1/status", adminToken(), {
      title: `${TITLE_PREFIX} audited`, body: "b", severity: "minor",
    });
    const { incident } = await create.json();
    created.push(incident.id);
    await post(app, `/api/v1/status/${incident.id}/resolve`, adminToken());

    // record() is fire-and-forget; give the insert a beat to land.
    await new Promise(r => setTimeout(r, 250));
    const events = await testDb.select().from(auditEvents).where(like(auditEvents.action, "status.incident.%"));
    const mine = events.filter(e => (e.metadata as { incidentId?: string })?.incidentId === incident.id);
    expect(mine.map(e => e.action).sort()).toEqual(["status.incident.opened", "status.incident.resolved"]);
    for (const e of mine) {
      expect(e.actorKind).toBe("human");
      expect(e.actorId).toBe(ADMIN_USER_ID);
      expect(e.actorHandle).toBe(ADMIN_EMAIL);
      expect(e.category).toBe("admin");
    }
  });
});
