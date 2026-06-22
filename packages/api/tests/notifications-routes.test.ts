import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { createNotificationRoutes } from "../src/routes/notifications.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { notifications } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";

process.env.JWT_SECRET ??= "test-secret-notif-routes";
const { signToken } = await import("../src/services/auth.js");
const USER = { headers: { authorization: `Bearer ${signToken({ kind: "user", userId: "u1", email: "t@t" })}` } };
const AGENT = { headers: { authorization: `Bearer ${signToken({ kind: "agent", agentId: "ag1", name: "bot" })}` } };

// The inbox routes (GET / + /unread-count, POST /read + /read-all) must mount
// without shadowing /prefs + /mentions, gate to users only, and return the
// expected shapes. Cross-tenant scoping lives in the service WHERE clauses
// (covered by reading + the adversarial review); here we prove dispatch + authz.
function makeFakeDb(): DB {
  const world: Record<string, unknown[]> = {
    notifications: [{ id: "n1", userId: "u1", kind: "mention", title: "hi", read: false, createdAt: new Date() }],
  };
  const keyOf = (t: unknown) => (t === notifications ? "notifications" : "?");
  const db = {
    select: (_cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = world[keyOf(t)] ?? [];
        const chain = {
          where: (_c: unknown) => chain,
          orderBy: (_c: unknown) => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (res: (v: unknown[]) => void) => res(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      },
    }),
    update: (_t: unknown) => ({ set: (_v: unknown) => ({ where: (_c: unknown) => Promise.resolve() }) }),
  };
  return db as unknown as DB;
}

let app: Hono;
beforeAll(() => {
  app = new Hono();
  app.route("/api/v1/notifications", createNotificationRoutes(makeFakeDb()));
  app.onError(errorHandler);
});

describe("notification inbox routes", () => {
  it("GET / returns the caller's notifications for a user", async () => {
    const res = await app.request("/api/v1/notifications", USER);
    expect(res.status).toBe(200);
    const json = await res.json() as { notifications: Array<{ id: string }> };
    expect(json.notifications[0].id).toBe("n1");
  });

  it("GET / rejects an agent token (users only)", async () => {
    const res = await app.request("/api/v1/notifications", AGENT);
    expect(res.status).toBe(401);
  });

  it("GET /unread-count returns a numeric count for a user", async () => {
    const res = await app.request("/api/v1/notifications/unread-count", USER);
    expect(res.status).toBe(200);
    expect(typeof (await res.json() as { count: number }).count).toBe("number");
  });

  it("POST /read marks given ids and returns ok", async () => {
    const res = await app.request("/api/v1/notifications/read", { method: "POST", ...USER, body: JSON.stringify({ ids: ["n1"] }) });
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });

  it("POST /read-all returns ok for a user and rejects an agent", async () => {
    const ok = await app.request("/api/v1/notifications/read-all", { method: "POST", ...USER });
    expect(ok.status).toBe(200);
    const denied = await app.request("/api/v1/notifications/read-all", { method: "POST", ...AGENT });
    expect(denied.status).toBe(401);
  });
});
