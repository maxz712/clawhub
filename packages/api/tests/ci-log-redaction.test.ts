// #142 — a CI run's OUTPUT was the one uncontrolled direction. Delivery of run
// secrets is bound four ways (constant-time runnerToken compare, claimed run,
// agent Bearer, standing-run owner binding), but whatever the run PRINTED was
// stored and served verbatim behind repo READ — any signed-up user on a public
// repo, and the low-trust `reviewer` tier on a private one. These tests pin the
// masking primitive and, more importantly, that masking happens SERVER-SIDE at
// the sink, so an un-upgraded or hostile runner that did none can't publish
// plaintext.
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { errorHandler } from "../src/middleware/errorHandler.js";
import { ciRuns, repositories, secrets as secretsTable, standingAgents, users } from "../src/models/schema.js";
import type { DB } from "../src/models/db.js";
import type { EventBus } from "../src/services/events.js";
import type { ObjectStore } from "../src/services/object-store.js";
import {
  MIN_SECRET_LENGTH, REDACTED, isMaskableValue, redactDeep, redactSecrets, redactionPatterns,
} from "../src/services/log-redact.js";

process.env.JWT_SECRET ??= "test-secret-142";
process.env.CLAWHUB_SECRETS_KEY ??= util.encodeBase64(nacl.randomBytes(32));

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

// ── The primitive ────────────────────────────────────────────────────────────
describe("redactSecrets covers the encodings a log realistically carries (#142)", () => {
  it("masks an exact value and one embedded mid-line", () => {
    const p = redactionPatterns(["ghp_supersecrettoken"]);
    expect(redactSecrets("ghp_supersecrettoken", p).text).toBe(REDACTED);
    expect(redactSecrets("curl -H 'auth: ghp_supersecrettoken' https://x", p).text)
      .toBe(`curl -H 'auth: ${REDACTED}' https://x`);
  });

  it("masks base64(value) — a token written into a config file", () => {
    const p = redactionPatterns(["ghp_supersecrettoken"]);
    const line = `{"auth":"${b64("ghp_supersecrettoken")}"}`;
    const out = redactSecrets(line, p).text;
    expect(out).not.toContain(b64("ghp_supersecrettoken"));
    expect(out).toContain(REDACTED);
  });

  it("masks base64(user:token) — the docker-config shape build-harness writes", () => {
    const p = redactionPatterns(["ghcr-robot", "ghp_supersecrettoken"]);
    const docker = `{"auths":{"ghcr.io":{"auth":"${b64("ghcr-robot:ghp_supersecrettoken")}"}}}`;
    const out = redactSecrets(docker, p).text;
    // The composite must be masked as a WHOLE — a substring-only fix leaves the
    // rest of the base64 blob (and therefore the credential) recoverable.
    expect(out).not.toContain(b64("ghcr-robot:ghp_supersecrettoken"));
    expect(out).toBe(`{"auths":{"ghcr.io":{"auth":"${REDACTED}"}}}`);
  });

  it("masks the URL-encoded spelling", () => {
    const secret = "p@ss word/with+chars";
    const p = redactionPatterns([secret]);
    const out = redactSecrets(`POST body: token=${encodeURIComponent(secret)}&x=1`, p).text;
    expect(out).not.toContain(encodeURIComponent(secret));
    expect(out).toBe(`POST body: token=${REDACTED}&x=1`);
  });

  it("masks multiple distinct secrets on one line and counts every hit", () => {
    const p = redactionPatterns(["first-secret-value", "second-secret-value"]);
    const r = redactSecrets("A=first-secret-value B=second-secret-value A2=first-secret-value", p);
    expect(r.text).toBe(`A=${REDACTED} B=${REDACTED} A2=${REDACTED}`);
    expect(r.count).toBe(3);
  });

  it("masks the same value in both sinks — rawLogs text and a stepResults blob", () => {
    const p = redactionPatterns(["ghp_supersecrettoken"]);
    expect(redactSecrets("stdout: ghp_supersecrettoken", p).text).toBe(`stdout: ${REDACTED}`);
    const steps = [{ name: "build", passed: false, out: "echo ghp_supersecrettoken", err: "" }];
    const deep = redactDeep(steps, p);
    expect(deep.value[0].out).toBe(`echo ${REDACTED}`);
    expect(JSON.stringify(deep.value)).not.toContain("ghp_supersecrettoken");
  });

  it("leaves object KEYS alone — those are secret NAMES, not values", () => {
    const p = redactionPatterns(["ghp_supersecrettoken"]);
    const out = redactDeep({ GHCR_TOKEN: "ghp_supersecrettoken" }, p).value;
    expect(Object.keys(out)).toEqual(["GHCR_TOKEN"]);
    expect(out.GHCR_TOKEN).toBe(REDACTED);
  });

  it("skips short and deny-listed values so ordinary log text isn't `***` soup", () => {
    // `DEBUG=1`, `NODE_ENV=production`: present in real secret bags, not secrets.
    const p = redactionPatterns(["1", "true", "production", "abc"]);
    expect(p).toEqual([]);
    const line = "1 build in production mode: true (abc)";
    expect(redactSecrets(line, p).text).toBe(line);
    expect(isMaskableValue("x".repeat(MIN_SECRET_LENGTH - 1))).toBe(false);
    expect(isMaskableValue("x".repeat(MIN_SECRET_LENGTH))).toBe(true);
  });

  it("orders patterns longest-first so a composite isn't shredded by its parts", () => {
    const p = redactionPatterns(["alpha-user", "beta-token"]);
    for (let i = 1; i < p.length; i++) expect(p[i - 1].length).toBeGreaterThanOrEqual(p[i].length);
  });
});

// ── The sink: POST /api/v1/ci/runs/:id ───────────────────────────────────────
describe("the API masks at the sink, not (only) in the runner (#142)", () => {
  let createCiRoutes: typeof import("../src/routes/ci.js").createCiRoutes;
  let seal: (v: string) => { ciphertext: string; nonce: string };

  beforeAll(async () => {
    ({ createCiRoutes } = await import("../src/routes/ci.js"));
    ({ seal } = await import("../src/services/secrets.js"));
  });

  // An in-memory ObjectStore — the log blob's real destination.
  function makeStore(): { store: ObjectStore; blobs: Map<string, string> } {
    const blobs = new Map<string, string>();
    const store = {
      put: async (key: string, body: Buffer) => { blobs.set(key, body.toString("utf8")); return { etag: "e", size: body.length }; },
      get: async (key: string) => {
        const v = blobs.get(key);
        if (v === undefined) return null;
        return { stream: (async function* () { yield Buffer.from(v); })() as unknown as NodeJS.ReadableStream, size: v.length };
      },
      exists: async (key: string) => blobs.has(key),
      url: async (key: string) => key,
      delete: async (key: string) => { blobs.delete(key); },
    } as unknown as ObjectStore;
    return { store, blobs };
  }

  // A fake DB just rich enough for the POST handler. The terminal UPDATE returns
  // [] (the "already finalized, idempotent no-op" branch of updateRunFromRunner),
  // which keeps the test on the masking path without dragging in every terminal
  // side effect — while still capturing exactly what would have been persisted.
  function makeWorld(opts: {
    standing?: { tokenPlain: string; llmPlain: string };
    repoSecrets?: Array<{ name: string; value: string }>;
  }) {
    const sealedSecrets = (opts.repoSecrets ?? []).map(s => ({ name: s.name, ...seal(s.value) }));
    const sa = opts.standing
      ? [{
        id: "sa1", agentId: "agent1",
        ...(() => { const t = seal(opts.standing.tokenPlain); return { tokenCiphertext: t.ciphertext, tokenNonce: t.nonce }; })(),
        ...(() => { const l = seal(opts.standing!.llmPlain); return { llmCiphertext: l.ciphertext, llmNonce: l.nonce }; })(),
      }]
      : [];
    const world = new Map<unknown, unknown[]>([
      [ciRuns, [{ id: "run1", runnerToken: "rt-123", status: "running", standingAgentId: opts.standing ? "sa1" : null, repoId: "repo1", logUrl: null, stepResults: null, startedAt: new Date(), finishedAt: null, changeId: null, workflowId: null }]],
      [repositories, [{ id: "repo1", name: "demo", namespaceType: "user", namespaceId: "u1" }]],
      [secretsTable, sealedSecrets],
      [standingAgents, sa],
      // namespaceNameOf(user) — the log URL the sink stamps on the run.
      [users, [{ id: "u1", username: "alice" }]],
    ]);
    const persisted: Record<string, unknown>[] = [];
    const db = {
      select: (_c?: unknown) => ({ from: (t: unknown) => {
        const rows = (world.get(t) ?? []) as unknown[];
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: (n: number) => Promise.resolve(rows.slice(0, n)),
          then: (r: (v: unknown[]) => void) => r(rows),
        };
        return chain as typeof chain & PromiseLike<unknown[]>;
      } }),
      update: () => ({ set: (v: Record<string, unknown>) => { persisted.push(v); return { where: () => ({ returning: () => Promise.resolve([]) }) }; } }),
    } as unknown as DB;
    return { db, persisted };
  }

  function makeApp(db: DB, store: ObjectStore): Hono {
    const app = new Hono();
    app.route("/api/v1/ci", createCiRoutes(db, { publish: async () => {} } as unknown as EventBus, store, "https://api.test").public);
    app.onError(errorHandler);
    return app;
  }

  // The exact shape of an un-upgraded/hostile runner: a direct POST with a valid
  // runnerToken and no client-side masking whatsoever.
  const post = (app: Hono, body: Record<string, unknown>) =>
    app.request("/api/v1/ci/runs/run1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner_token: "rt-123", status: "success", ...body }),
    });

  it("a PIPELINE run's repo secret is masked in the stored log blob", async () => {
    const { db } = makeWorld({ repoSecrets: [{ name: "GHCR_TOKEN", value: "ghp_pipelinesecret1" }] });
    const { store, blobs } = makeStore();
    const res = await post(makeApp(db, store), { rawLogs: "=== step: push ===\nlogging in with ghp_pipelinesecret1\n" });
    expect(res.status).toBe(200);
    const stored = blobs.get("logs/run1.txt")!;
    expect(stored).not.toContain("ghp_pipelinesecret1");
    expect(stored).toContain(REDACTED);
  });

  it("the SECOND sink is closed too — stepResults[].out/err never persist plaintext", async () => {
    const { db, persisted } = makeWorld({ repoSecrets: [{ name: "GHCR_TOKEN", value: "ghp_pipelinesecret1" }] });
    const { store } = makeStore();
    await post(makeApp(db, store), {
      step_results: [{ name: "push", passed: false, out: "auth=ghp_pipelinesecret1", err: "failed for ghp_pipelinesecret1" }],
    });
    const wrote = persisted.find(p => "stepResults" in p)!;
    expect(JSON.stringify(wrote.stepResults)).not.toContain("ghp_pipelinesecret1");
    expect(JSON.stringify(wrote.stepResults)).toContain(REDACTED);
  });

  it("a STANDING run's agent push JWT and BYO-LLM key are masked at BOTH sinks", async () => {
    const { db, persisted } = makeWorld({ standing: { tokenPlain: "eyJhZ2VudC10b2tlbi1wbGFpbnRleHQ", llmPlain: "sk-ant-byo-key-plaintext" } });
    const { store, blobs } = makeStore();
    await post(makeApp(db, store), {
      rawLogs: "=== standing-agent ===\nCLAWHUB_TOKEN=eyJhZ2VudC10b2tlbi1wbGFpbnRleHQ ANTHROPIC_API_KEY=sk-ant-byo-key-plaintext\n",
      step_results: [{ name: "standing-agent", out: "key sk-ant-byo-key-plaintext", err: "token eyJhZ2VudC10b2tlbi1wbGFpbnRleHQ" }],
    });
    const stored = blobs.get("logs/run1.txt")!;
    expect(stored).not.toContain("eyJhZ2VudC10b2tlbi1wbGFpbnRleHQ");
    expect(stored).not.toContain("sk-ant-byo-key-plaintext");
    const wrote = persisted.find(p => "stepResults" in p)!;
    const json = JSON.stringify(wrote.stepResults);
    expect(json).not.toContain("eyJhZ2VudC10b2tlbi1wbGFpbnRleHQ");
    expect(json).not.toContain("sk-ant-byo-key-plaintext");
  });

  it("what the logs endpoint reads back is the masked blob (no plaintext at rest)", async () => {
    const { db } = makeWorld({ repoSecrets: [{ name: "GHCR_TOKEN", value: "ghp_pipelinesecret1" }] });
    const { store, blobs } = makeStore();
    await post(makeApp(db, store), { rawLogs: "token ghp_pipelinesecret1" });
    // The read route is a straight passthrough of this object, so masking at
    // write time is what every reader (down to `reviewer`) can ever see.
    const obj = await store.get("logs/run1.txt");
    const chunks: Buffer[] = [];
    for await (const ch of obj!.stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(ch));
    expect(chunks.map(String).join("")).toBe(`token ${REDACTED}`);
    expect(blobs.get("logs/run1.txt")).not.toContain("ghp_pipelinesecret1");
  });

  it("a wrong runnerToken cannot write a run's log blob at all", async () => {
    const { db } = makeWorld({ repoSecrets: [] });
    const { store, blobs } = makeStore();
    const res = await makeApp(db, store).request("/api/v1/ci/runs/run1", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runner_token: "not-the-token", status: "success", rawLogs: "poisoned" }),
    });
    expect(res.status).toBe(401);
    expect(blobs.has("logs/run1.txt")).toBe(false);
  });

  it("a short/deny-listed secret does not turn the log into `***` soup", async () => {
    const { db } = makeWorld({ repoSecrets: [{ name: "DEBUG", value: "1" }, { name: "NODE_ENV", value: "production" }] });
    const { store, blobs } = makeStore();
    const line = "1 test passed in production mode\n";
    await post(makeApp(db, store), { rawLogs: line });
    expect(blobs.get("logs/run1.txt")).toBe(line);
  });
});
