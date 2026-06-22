import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { isValidWebhookEvent, WEBHOOK_EVENT_TYPES } from "../src/services/event-catalog.js";
import { verifyHmac } from "../src/routes/external-sync.js";
import { runnerAllowlistConfigured, isAllowlistedRunner } from "../src/services/runner-allowlist.js";
import { createCiRoutes } from "../src/routes/ci.js";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ciRuns, secrets } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { EventBus } from "../src/services/events.js";

process.env.JWT_SECRET ??= "test-secret-batch4";
const { signToken } = await import("../src/services/auth.js");

// ── Item 6: webhook event-name validation ─────────────────────────────────────
describe("webhook event catalog", () => {
  it("accepts catalog members and the wildcard", () => {
    expect(isValidWebhookEvent("*")).toBe(true);
    expect(isValidWebhookEvent("change.merged")).toBe(true);
    expect(isValidWebhookEvent(WEBHOOK_EVENT_TYPES[0])).toBe(true);
  });
  it("rejects typos / unknown names the audit flagged", () => {
    expect(isValidWebhookEvent("change.merge")).toBe(false); // the canonical typo
    expect(isValidWebhookEvent("pr.opened")).toBe(false);
    expect(isValidWebhookEvent("ci.run.queued")).toBe(false); // internal, not subscribable
    expect(isValidWebhookEvent("")).toBe(false);
  });
});

// ── Item 5: Jira/Linear inbound HMAC ──────────────────────────────────────────
describe("external-sync verifyHmac", () => {
  const secret = "s3cr3t-shared";
  const raw = JSON.stringify({ webhookEvent: "jira:issue_created" });
  const good = createHmac("sha256", secret).update(raw).digest("hex");

  it("accepts a correct bare-hex digest (Linear style)", () => {
    expect(verifyHmac(raw, secret, good)).toBe(true);
  });
  it("accepts a correct sha256=<hex> digest (our scheme / Jira)", () => {
    expect(verifyHmac(raw, secret, `sha256=${good}`)).toBe(true);
  });
  it("rejects a wrong signature, wrong secret, and a missing signature", () => {
    expect(verifyHmac(raw, secret, good.replace(/.$/, "0"))).toBe(false);
    expect(verifyHmac(raw, "other-secret", good)).toBe(false);
    expect(verifyHmac(raw, secret, undefined)).toBe(false);
    expect(verifyHmac(raw, secret, "not-hex")).toBe(false);
  });
});

// ── Item 4: CI secrets-pull bound to an allowlisted runner agent ──────────────
describe("CI secrets-pull binding (CLAWHUB_RUNNER_AGENT_IDS)", () => {
  const prev = process.env.CLAWHUB_RUNNER_AGENT_IDS;
  afterEach(() => { if (prev === undefined) delete process.env.CLAWHUB_RUNNER_AGENT_IDS; else process.env.CLAWHUB_RUNNER_AGENT_IDS = prev; });

  function makeApp(): Hono {
    const world: Record<string, unknown[]> = {
      ci_runs: [{ id: "run1", runnerToken: "rt-123", status: "running", standingAgentId: null, repoId: "repo1" }],
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

  it("with an allowlist configured, a runnerToken-only pull is rejected", async () => {
    process.env.CLAWHUB_RUNNER_AGENT_IDS = "agent-op-1";
    expect(runnerAllowlistConfigured()).toBe(true);
    const res = await makeApp().request("/api/v1/ci/runs/run1/secrets", { headers: { "x-runner-token": "rt-123" } });
    expect(res.status).toBe(401);
  });

  it("with an allowlist, a pull carrying an allowlisted agent token succeeds", async () => {
    process.env.CLAWHUB_RUNNER_AGENT_IDS = "agent-op-1";
    expect(isAllowlistedRunner("agent-op-1")).toBe(true);
    const agentToken = signToken({ kind: "agent", agentId: "agent-op-1", name: "op" });
    const res = await makeApp().request("/api/v1/ci/runs/run1/secrets", {
      headers: { "x-runner-token": "rt-123", authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { secrets: Record<string, string> }).secrets).toEqual({});
  });

  it("with an allowlist, a NON-allowlisted agent token is rejected", async () => {
    process.env.CLAWHUB_RUNNER_AGENT_IDS = "agent-op-1";
    const agentToken = signToken({ kind: "agent", agentId: "some-other-agent", name: "x" });
    const res = await makeApp().request("/api/v1/ci/runs/run1/secrets", {
      headers: { "x-runner-token": "rt-123", authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("with NO allowlist (single-tenant), a runnerToken-only pull still works", async () => {
    delete process.env.CLAWHUB_RUNNER_AGENT_IDS;
    expect(runnerAllowlistConfigured()).toBe(false);
    const res = await makeApp().request("/api/v1/ci/runs/run1/secrets", { headers: { "x-runner-token": "rt-123" } });
    expect(res.status).toBe(200);
  });
});
