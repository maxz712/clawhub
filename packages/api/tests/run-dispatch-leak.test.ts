// #134 — `ci.run.queued` carries the per-run runnerToken, which redeems at
// `GET /ci/runs/:id/secrets` for every plaintext repo CI secret. The catalog
// (services/event-catalog.ts) said so, but the exclusion was enforced only where
// a webhook SUBSCRIBES. Both fan-out paths that actually DELIVER events applied
// no equivalent filter, so the token escaped to two audiences it was never meant
// to reach. These tests pin the dispatch-side gates and the sink's binding.
import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { isDeliverableWebhookEvent, isValidWebhookEvent } from "../src/services/event-catalog.js";
import { WebhookDispatcher } from "../src/services/webhook-queue.js";
import { mayReceiveRunDispatch } from "../src/routes/events.js";
import { createCiRoutes } from "../src/routes/ci.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ciRuns, repoCollaborators, secrets, webhookDeliveries, webhooks } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { EventBus, BusEvent } from "../src/services/events.js";
import type { TokenPayload } from "../src/services/auth.js";

process.env.JWT_SECRET ??= "test-secret-134";
const { signToken } = await import("../src/services/auth.js");

// ── Leak path 1: webhook dispatch ────────────────────────────────────────────
describe("webhook dispatch never delivers credential-bearing events (#134)", () => {
  // A fake DB just rich enough for the dispatcher: one enabled hook per repo,
  // recorded inserts, and an empty due-queue so the post-enqueue tick is inert.
  function makeDb(hookEvents: string[]): { db: DB; enqueued: Record<string, unknown>[] } {
    const enqueued: Record<string, unknown>[] = [];
    const hook = { id: "hook1", repoId: "repo1", url: "https://hooks.example.com/x", secret: "s", events: hookEvents, enabled: true };
    const rowsFor = (t: unknown) => (t === webhooks ? [hook] : []);
    const db = {
      select: (_c?: unknown) => ({ from: (t: unknown) => {
        const rows = rowsFor(t);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (r: (v: unknown[]) => void) => r(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      } }),
      insert: (t: unknown) => ({ values: (v: Record<string, unknown>) => ({ returning: () => {
        if (t === webhookDeliveries) enqueued.push(v);
        return Promise.resolve([{ id: "d1", ...v }]);
      } }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    } as unknown as DB;
    return { db, enqueued };
  }

  // Capture the handler WebhookDispatcher.start() registers, then feed it events
  // directly — that is the exact code path a publish takes.
  function wire(hookEvents: string[]): { fire: (e: BusEvent) => Promise<void>; enqueued: Record<string, unknown>[] } {
    const { db, enqueued } = makeDb(hookEvents);
    let handler: ((e: BusEvent) => Promise<void>) | null = null;
    const bus = { onEvent: (h: (e: BusEvent) => Promise<void>) => { handler = h; return () => {}; } } as unknown as EventBus;
    const d = new WebhookDispatcher(db, bus);
    d.start();
    d.stop(); // keep the retry interval out of the test; the handler stays wired
    return { fire: e => handler!(e), enqueued };
  }

  const RUN_QUEUED: BusEvent = {
    type: "ci.run.queued", repoId: "repo1",
    payload: { runId: "run1", runnerToken: "rt-secret", pipelineYaml: "steps: []" },
  } as unknown as BusEvent;
  const CHANGE_OPENED = { type: "change.opened", repoId: "repo1", changeId: "c1", payload: {} } as unknown as BusEvent;

  it('the documented default (events: []) receives change.opened but NOT ci.run.queued', async () => {
    const { fire, enqueued } = wire([]);
    await fire(CHANGE_OPENED);
    await fire(RUN_QUEUED);
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as { payload: { type: string } }).payload.type).toBe("change.opened");
    expect(JSON.stringify(enqueued)).not.toContain("rt-secret");
  });

  it('the explicit wildcard (events: ["*"]) is narrowed the same way', async () => {
    const { fire, enqueued } = wire(["*"]);
    await fire(CHANGE_OPENED);
    await fire(RUN_QUEUED);
    expect(enqueued).toHaveLength(1);
    expect(JSON.stringify(enqueued)).not.toContain("rt-secret");
  });

  it("other internal event families are excluded by the same catalog filter", async () => {
    const { fire, enqueued } = wire([]);
    await fire({ type: "shard.failover", repoId: "repo1", payload: {} } as unknown as BusEvent);
    expect(enqueued).toHaveLength(0);
  });

  it("an explicit subscription to a catalog event still fires", async () => {
    const { fire, enqueued } = wire(["change.opened"]);
    await fire(CHANGE_OPENED);
    await fire(RUN_QUEUED);
    expect(enqueued).toHaveLength(1);
  });

  it("`*` is a valid SUBSCRIPTION but never a deliverable event type", () => {
    expect(isValidWebhookEvent("*")).toBe(true);
    expect(isDeliverableWebhookEvent("*")).toBe(false);
    expect(isDeliverableWebhookEvent("ci.run.queued")).toBe(false);
    expect(isDeliverableWebhookEvent("change.opened")).toBe(true);
  });
});

// ── Leak path 2: the SSE run-dispatch gate ───────────────────────────────────
describe("mayReceiveRunDispatch grades the collaborator grant (#134)", () => {
  const prev = process.env.CLAWHUB_RUNNER_AGENT_IDS;
  afterEach(() => { if (prev === undefined) delete process.env.CLAWHUB_RUNNER_AGENT_IDS; else process.env.CLAWHUB_RUNNER_AGENT_IDS = prev; });

  function dbWithCollab(row: { role: string } | null): DB {
    return {
      select: (_c?: unknown) => ({ from: (t: unknown) => {
        const rows = t === repoCollaborators && row ? [row] : [];
        const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)) };
        return chain as typeof chain & PromiseLike<unknown[]>;
      } }),
    } as unknown as DB;
  }
  const agent: TokenPayload = { kind: "agent", agentId: "a1", name: "runner" };

  it("refuses a reviewer-role collaborator — the low-trust marketplace tier", async () => {
    expect(await mayReceiveRunDispatch(dbWithCollab({ role: "reviewer" }), agent, "repo1")).toBe(false);
  });

  it("allows a writer-role collaborator", async () => {
    expect(await mayReceiveRunDispatch(dbWithCollab({ role: "writer" }), agent, "repo1")).toBe(true);
  });

  it("still refuses a non-collaborator and any user token", async () => {
    expect(await mayReceiveRunDispatch(dbWithCollab(null), agent, "repo1")).toBe(false);
    const user: TokenPayload = { kind: "user", userId: "u1", email: "u@example.test" };
    expect(await mayReceiveRunDispatch(dbWithCollab({ role: "writer" }), user, "repo1")).toBe(false);
  });

  it("still allows an allowlisted operator runner regardless of grant", async () => {
    process.env.CLAWHUB_RUNNER_AGENT_IDS = "a1";
    expect(await mayReceiveRunDispatch(dbWithCollab(null), agent, "repo1")).toBe(true);
  });
});

// ── The shared sink: a pipeline run's secrets ────────────────────────────────
describe("pipeline-run secrets are bound like standing-run secrets (#134)", () => {
  const prev = process.env.CLAWHUB_RUNNER_AGENT_IDS;
  afterEach(() => { if (prev === undefined) delete process.env.CLAWHUB_RUNNER_AGENT_IDS; else process.env.CLAWHUB_RUNNER_AGENT_IDS = prev; });

  function makeApp(status: string): Hono {
    const world: Record<string, unknown[]> = {
      ci_runs: [{ id: "run1", runnerToken: "rt-123", status, standingAgentId: null, repoId: "repo1" }],
      secrets: [],
    };
    const keyOf = (t: unknown) => (t === ciRuns ? "ci_runs" : t === secrets ? "secrets" : "?");
    const db = {
      select: (_c?: unknown) => ({ from: (t: unknown) => {
        const rows = world[keyOf(t)] ?? [];
        const chain = { where: () => chain, limit: (n: number) => Promise.resolve(rows.slice(0, n)), then: (r: (v: unknown[]) => void) => r(rows) };
        return chain as typeof chain & PromiseLike<unknown[]>;
      } }),
    } as unknown as DB;
    const app = new Hono();
    app.route("/api/v1/ci", createCiRoutes(db, { publish: async () => {} } as unknown as EventBus).public);
    app.onError(errorHandler);
    return app;
  }
  const runnerToken = { "x-runner-token": "rt-123" };
  const bearer = `Bearer ${signToken({ kind: "agent", agentId: "runner-1", name: "runner" })}`;

  it("rejects a runnerToken-only pull even single-tenant — a scraped token is not enough", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    const res = await makeApp("running").request("/api/v1/ci/runs/run1/secrets", { headers: runnerToken });
    expect(res.status).toBe(401);
  });

  it("rejects a pull before the run is CLAIMED, closing the queued-token window", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    const res = await makeApp("pending").request("/api/v1/ci/runs/run1/secrets", {
      headers: { ...runnerToken, authorization: bearer },
    });
    expect(res.status).toBe(401);
  });

  it("admits a claimed run pulled with the runnerToken PLUS a resolving agent token", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    const res = await makeApp("running").request("/api/v1/ci/runs/run1/secrets", {
      headers: { ...runnerToken, authorization: bearer },
    });
    expect(res.status).toBe(200);
  });

  it("a garbage Bearer does not satisfy the binding", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    const res = await makeApp("running").request("/api/v1/ci/runs/run1/secrets", {
      headers: { ...runnerToken, authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  it("a USER token does not satisfy the binding — dispatch only ever reaches agents", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    const userToken = signToken({ kind: "user", userId: "u1", email: "u@example.test" });
    const res = await makeApp("running").request("/api/v1/ci/runs/run1/secrets", {
      headers: { ...runnerToken, authorization: `Bearer ${userToken}` },
    });
    expect(res.status).toBe(401);
  });
});
