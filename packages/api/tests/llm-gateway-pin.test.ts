import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/models/db.js";
import {
  ciRuns, standingAgents, repositories, organizations, orgLlmKeys, platformUsage,
} from "../src/models/schema.js";
import { catalogEntry, catalogPriceMicroUsd, providerBlock, openModelCatalog } from "../src/services/llm-catalog.js";
import { resolveModelPrice, priceUsageMicroUsd } from "../src/services/llm-pricing.js";
import { hashGatewayToken } from "../src/services/llm-gateway.js";
import { metrics } from "../src/services/metrics.js";

// #143 — the D8 pin on the ANTHROPIC protocol's OpenRouter fallback.
//
// `/openai/v1/chat/completions` has always refused an uncatalogued model and FORCED
// the US-host provider block. The Anthropic route has a second path to the very same
// OpenRouter key (`viaOpenRouter`, taken whenever no native Anthropic key is
// configured) that reached upstream with no catalog gate, no provider block, no org
// allowlist — and priced DeepSeek/Qwen at Sonnet rates. That is the path a
// default-configured platform-keyed Loop takes: `standing_agents.llmProvider`
// defaults to `anthropic`, which selects this gateway.
//
// These tests drive the real Hono route with a fake DB + a mocked upstream fetch, so
// they run in the DB-less default suite. Every assertion below FAILS on the code
// before the fix.

// Redis-backed spend counters are not what's under test here, and they must not open
// a live connection from vitest.
vi.mock("../src/services/platform-quota.js", () => ({
  globalCapExceeded: async () => false,
  addGlobalSpend: async () => {},
  addTenantInputTokens: async () => {},
}));
vi.mock("../src/services/platform-billing.js", () => ({
  checkPlatformBudget: async () => ({ mode: "allow" }),
}));

const { createLlmGatewayRoutes } = await import("../src/routes/llm-gateway.js");

const GW_TOKEN = "chgw_pin_test_token";
const OR_KEY = "sk-or-TEST-openrouter";

// ── Fake DB ────────────────────────────────────────────────────────────────
// Only enough Drizzle chain to answer the handful of queries the gateway makes.
// Fixtures hold at most one row per table, so `where` needs no evaluation.
interface World {
  runs: Record<string, unknown>[];
  standingAgents: Record<string, unknown>[];
  repositories: Record<string, unknown>[];
  organizations: Record<string, unknown>[];
  orgLlmKeys: Record<string, unknown>[];
  usage: Record<string, unknown>[];
}

function makeWorld(opts: { orgId?: string; allowlist?: string[] | null } = {}): World {
  const nsType = opts.orgId ? "org" : "user";
  const nsId = opts.orgId ?? "user-1";
  // The fake returns rows verbatim rather than applying the SELECT projection, so
  // fixtures carry the projected aliases (`nsType`/`nsId`, `allow`) alongside the
  // schema field names the production code reads them from.
  return {
    runs: [{ id: "run-1", status: "running", repoId: "repo-1", changeId: null, standingAgentId: null, gatewayTokenHash: hashGatewayToken(GW_TOKEN) }],
    standingAgents: [],
    repositories: [{ id: "repo-1", namespaceType: nsType, namespaceId: nsId, nsType, nsId }],
    organizations: opts.orgId ? [{ id: opts.orgId, llmProviderAllowlist: opts.allowlist ?? null, allow: opts.allowlist ?? null }] : [],
    orgLlmKeys: [],
    usage: [],
  };
}

function fakeDb(world: World): DB {
  const rowsFor = (t: unknown): Record<string, unknown>[] => {
    if (t === ciRuns) return world.runs;
    if (t === standingAgents) return world.standingAgents;
    if (t === repositories) return world.repositories;
    if (t === organizations) return world.organizations;
    if (t === orgLlmKeys) return world.orgLlmKeys;
    if (t === platformUsage) return world.usage;
    return [];
  };
  let seq = 0;
  class Q {
    rows: Record<string, unknown>[] = [];
    from(t: unknown) { this.rows = rowsFor(t); return this; }
    where() { return this; }
    orderBy() { return this; }
    limit() { return Promise.resolve(this.rows); }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(this.rows).then(res, rej); }
  }
  return {
    select: () => new Q(),
    insert: (t: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const row = { id: `row-${++seq}`, ...v };
        rowsFor(t).push(row);
        return {
          returning: () => Promise.resolve([row]),
          onConflictDoNothing: () => Promise.resolve([row]),
          onConflictDoUpdate: () => Promise.resolve([row]),
          then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve([row]).then(res, rej),
        };
      },
    }),
    update: (t: unknown) => ({
      set: (v: Record<string, unknown>) => ({
        where: () => { Object.assign(rowsFor(t)[0] ?? {}, v); return Promise.resolve([]); },
      }),
    }),
  } as unknown as DB;
}

function post(app: ReturnType<typeof createLlmGatewayRoutes>, body: Record<string, unknown>) {
  return app.request("/anthropic/v1/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${GW_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The JSON body the route actually sent upstream. */
function upstreamBody(fetchMock: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function anthropicJson(usage: Record<string, number>) {
  return () => new Response(
    JSON.stringify({ id: "msg_1", model: "whatever-upstream-says", content: [{ type: "text", text: "ok" }], usage }),
    { status: 200, headers: { "content-type": "application/json" } },
  ) as unknown as Response;
}

const SAVED: Record<string, string | undefined> = {};
const ENV = ["CLAWHUB_PLATFORM_ANTHROPIC_KEY", "CLAWHUB_PLATFORM_OPENAI_KEY", "CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP", "CLAWHUB_PLATFORM_OPENAI_CATALOG", "CLAWHUB_PLATFORM_MODEL_PRICES"];

beforeEach(() => {
  for (const k of ENV) SAVED[k] = process.env[k];
  // The exposed configuration: no native Anthropic key, an OpenRouter key present.
  delete process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY;
  delete process.env.CLAWHUB_PLATFORM_OPENAI_CATALOG;
  delete process.env.CLAWHUB_PLATFORM_MODEL_PRICES;
  process.env.CLAWHUB_PLATFORM_OPENAI_KEY = OR_KEY;
  process.env.CLAWHUB_PLATFORM_GLOBAL_MONTHLY_CAP = "0"; // skip the Redis-backed ceiling
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

describe("#143 · catalog gate on the Anthropic route's OpenRouter fallback", () => {
  it("rejects an UNCATALOGUED model with 400 uncatalogued_model and never calls upstream", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const app = createLlmGatewayRoutes(fakeDb(makeWorld()));

    const res = await post(app, { model: "deepseek/deepseek-chat-please-route-me-anywhere", messages: [{ role: "user", content: "hi" }], max_tokens: 10 });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: { message: string } };
    expect(body.error.message).toContain("not in the qualified open-model catalog");
    // The whole point: the platform key must not reach OpenRouter at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FORCES the US-host provider pin + resolved slug on a catalogued model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 10, output_tokens: 5 }));
    const app = createLlmGatewayRoutes(fakeDb(makeWorld()));

    const res = await post(app, {
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
      // Everything a prompt-injected container would try in order to widen routing.
      provider: { only: ["deepseek"], allow_fallbacks: true, data_collection: "allow" },
      models: ["deepseek/deepseek-chat"],
      route: "fallback",
      transforms: ["middle-out"],
      plugins: [{ id: "web" }],
      preset: "wide-open",
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sent = upstreamBody(fetchMock);
    const entry = catalogEntry("z-ai/glm-5.2")!;
    expect(sent.provider).toEqual(providerBlock(entry));
    expect((sent.provider as Record<string, unknown>).only).toEqual(["fireworks"]);
    expect((sent.provider as Record<string, unknown>).allow_fallbacks).toBe(false);
    expect((sent.provider as Record<string, unknown>).data_collection).toBe("deny");
    expect(sent.model).toBe(entry.id);
    // Container-supplied ROUTING fields are dropped, not forwarded.
    for (const k of ["models", "route", "transforms", "plugins", "preset"]) expect(sent[k]).toBeUndefined();
  });

  it("pins a quantization when the catalog entry declares one", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 1, output_tokens: 1 }));
    const app = createLlmGatewayRoutes(fakeDb(makeWorld()));
    await post(app, { model: "deepseek/deepseek-v4-flash", messages: [], max_tokens: 1 });
    const provider = upstreamBody(fetchMock).provider as Record<string, unknown>;
    expect(provider.quantizations).toEqual(["fp4"]);
    expect(provider.only).toEqual(["deepinfra"]);
  });

  it("labels the request metric with via=openrouter so the path is visible to operators", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 1, output_tokens: 1 }));
    const app = createLlmGatewayRoutes(fakeDb(makeWorld()));
    await post(app, { model: "z-ai/glm-5.2", messages: [], max_tokens: 1 });
    const scrape = metrics.toPrometheus();
    expect(scrape).toMatch(/clawhub_llm_gateway_request_total\{[^}]*protocol="anthropic"[^}]*via="openrouter"/);
  });

  it("leaves NATIVE Anthropic traffic alone (no pin, no catalog gate)", async () => {
    process.env.CLAWHUB_PLATFORM_ANTHROPIC_KEY = "sk-ant-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 10, output_tokens: 5 }));
    const app = createLlmGatewayRoutes(fakeDb(makeWorld()));

    const res = await post(app, { model: "claude-haiku-4-5-20251001", messages: [], max_tokens: 10 });

    expect(res.status).toBe(200); // a claude model is NOT in the open-model catalog, and must still work
    expect(upstreamBody(fetchMock).provider).toBeUndefined();
  });
});

describe("#143 · org provider allowlist (N3) on the Anthropic route", () => {
  it("denies a model routing outside the org's allowlist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // glm-5.2 pins to `fireworks`; the org permits only `deepinfra`.
    const app = createLlmGatewayRoutes(fakeDb(makeWorld({ orgId: "org-1", allowlist: ["deepinfra"] })));

    const res = await post(app, { model: "z-ai/glm-5.2", messages: [], max_tokens: 10 });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toContain("provider allowlist");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a model whose hosts are all inside the allowlist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 1, output_tokens: 1 }));
    const app = createLlmGatewayRoutes(fakeDb(makeWorld({ orgId: "org-1", allowlist: ["fireworks"] })));
    const res = await post(app, { model: "z-ai/glm-5.2", messages: [], max_tokens: 10 });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("#143 · metering the fallback at the CATALOG price, not Sonnet", () => {
  it("non-streaming: DeepSeek V4 Flash bills its catalog rate", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 1_000_000, output_tokens: 1_000_000 }));
    const world = makeWorld();
    const app = createLlmGatewayRoutes(fakeDb(world));

    const res = await post(app, { model: "deepseek/deepseek-v4-flash", messages: [], max_tokens: 10 });
    expect(res.status).toBe(200);

    const entry = catalogEntry("deepseek/deepseek-v4-flash")!;
    const expected = catalogPriceMicroUsd(entry, { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(expected).toBe(270_000); // $0.09 in + $0.18 out
    expect(world.usage).toHaveLength(1);
    expect(world.usage[0].costMicroUsd).toBe(expected);
    // The old Sonnet fall-through: $2 in + $10 out = 12_000_000 micro-USD, 44× high.
    expect(world.usage[0].costMicroUsd).not.toBe(12_000_000);
    // The usage row is keyed on the CATALOG slug, not the upstream echo.
    expect(world.usage[0].model).toBe(entry.id);
    expect((world.usage[0].meta as Record<string, unknown>).via).toBe("openrouter");
  });

  it("streaming: the tee'd meter also uses the catalog price", async () => {
    const sse = [
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1_000_000, output_tokens: 0 } } })}`,
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1_000_000 } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }) as unknown as Response);
    const world = makeWorld();
    const app = createLlmGatewayRoutes(fakeDb(world));

    const res = await post(app, { model: "deepseek/deepseek-v4-flash", messages: [], max_tokens: 10, stream: true });
    await res.text(); // drain the client half so the meter half completes
    await new Promise(r => setTimeout(r, 50));

    expect(world.usage).toHaveLength(1);
    expect(world.usage[0].costMicroUsd).toBe(270_000);
  });

  it("prefers an authoritative usage.cost when the compat endpoint surfaces one", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(anthropicJson({ input_tokens: 10, output_tokens: 10, cost: 0.000123 } as unknown as Record<string, number>));
    const world = makeWorld();
    const app = createLlmGatewayRoutes(fakeDb(world));
    await post(app, { model: "z-ai/glm-5.2", messages: [], max_tokens: 10 });
    expect(world.usage[0].costMicroUsd).toBe(123);
  });
});

describe("#143 · resolveModelPrice is catalog-aware", () => {
  it("prices EVERY catalogued slug from the catalog — none falls through to Sonnet", () => {
    const sonnet = resolveModelPrice("sonnet");
    for (const [id, entry] of Object.entries(openModelCatalog())) {
      const p = resolveModelPrice(id);
      expect(p.input, `${id} input`).toBe(entry.price.input);
      expect(p.output, `${id} output`).toBe(entry.price.output);
      // Guard the actual defect: the Anthropic backstop must not be what answered.
      if (entry.price.input !== sonnet.input || entry.price.output !== sonnet.output) {
        expect(p, `${id} priced at Sonnet`).not.toEqual(sonnet);
      }
    }
  });

  it("agrees with catalogPriceMicroUsd for the same usage (one price, two call sites)", () => {
    const u = { inputTokens: 30_000, outputTokens: 12_000, cacheReadTokens: 10_000 };
    for (const [id, entry] of Object.entries(openModelCatalog())) {
      expect(priceUsageMicroUsd(id, u), id).toBe(catalogPriceMicroUsd(entry, u));
    }
  });

  it("still fails UPWARD to Sonnet for a genuinely unknown id", () => {
    expect(resolveModelPrice("some-model-nobody-catalogued")).toEqual(resolveModelPrice("sonnet"));
  });

  it("an explicit CLAWHUB_PLATFORM_MODEL_PRICES entry still overrides the catalog", () => {
    process.env.CLAWHUB_PLATFORM_MODEL_PRICES = JSON.stringify({ "deepseek/deepseek-v4-flash": { input: 7, output: 9 } });
    const p = resolveModelPrice("deepseek/deepseek-v4-flash");
    expect(p.input).toBe(7);
    expect(p.output).toBe(9);
  });
});
