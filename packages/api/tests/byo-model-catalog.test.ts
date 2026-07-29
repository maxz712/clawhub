import { describe, it, expect, afterEach } from "vitest";
import { byoModelCatalog, byoModelsForProvider, normalizeByoProvider } from "../src/services/byo-model-catalog.js";

// #72 — BYO model selection: a static, per-provider catalog "auto detected"
// from a key's own `provider` column (no live network probe).

afterEach(() => { delete process.env.CLAWHUB_BYO_MODEL_CATALOG; });

describe("normalizeByoProvider", () => {
  it("collapses openrouter into openai and leaves anthropic/google as-is, else falls through to 'other'", () => {
    expect(normalizeByoProvider("openai")).toBe("openai");
    expect(normalizeByoProvider("openrouter")).toBe("openai");
    expect(normalizeByoProvider("google")).toBe("google");
    expect(normalizeByoProvider("anthropic")).toBe("anthropic");
    expect(normalizeByoProvider("other")).toBe("other");
  });
});

describe("byoModelsForProvider", () => {
  it("returns a non-empty curated list for anthropic and openai", () => {
    const claude = byoModelsForProvider("anthropic");
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.every(m => typeof m.id === "string" && m.id.length > 0)).toBe(true);

    const openai = byoModelsForProvider("openai");
    expect(openai.length).toBeGreaterThan(0);
  });

  it("routes an openrouter-provider key onto the same list as openai", () => {
    expect(byoModelsForProvider("openrouter")).toEqual(byoModelsForProvider("openai"));
  });

  it("returns an empty list for a provider with no curated catalog (free-text field)", () => {
    expect(byoModelsForProvider("other")).toEqual([]);
  });
});

describe("byoModelCatalog env override", () => {
  it("merges a valid CLAWHUB_BYO_MODEL_CATALOG override on top of the defaults", () => {
    process.env.CLAWHUB_BYO_MODEL_CATALOG = JSON.stringify({
      anthropic: [{ id: "claude-custom-9", label: "Claude Custom 9" }],
    });
    const cat = byoModelCatalog();
    expect(cat.anthropic).toEqual([{ id: "claude-custom-9", label: "Claude Custom 9" }]);
    // untouched provider keeps its default
    expect(cat.openai.length).toBeGreaterThan(0);
  });

  it("ignores a malformed override and falls back to defaults", () => {
    process.env.CLAWHUB_BYO_MODEL_CATALOG = "{not json";
    const cat = byoModelCatalog();
    expect(cat.anthropic.length).toBeGreaterThan(0);
  });

  it("ignores an override entry with no id and keeps the default list for that provider", () => {
    process.env.CLAWHUB_BYO_MODEL_CATALOG = JSON.stringify({ anthropic: [{ label: "no id" }] });
    const cat = byoModelCatalog();
    expect(cat.anthropic.length).toBeGreaterThan(0);
    expect(cat.anthropic.some(m => m.label === "no id")).toBe(false);
  });
});

// --- Live layer (the "dynamic" half): the provider's own models API, called
// with the user's key, so new Anthropic models appear with no ClawHub change.
// The fetch itself is stubbed; VITEST disables live calls unless the force
// flag is set, so no test ever touches a real provider.
import { vi } from "vitest";
import {
  mapAnthropicModels, selectableModelsForKey, isModelSelectableForKey, _clearLiveModelCacheForTests,
} from "../src/services/byo-model-catalog.js";

describe("static defaults (the fallback lineup)", () => {
  it("anthropic offers Fable 5 and Opus 5 (not the retired Opus 4.8)", () => {
    const ids = byoModelsForProvider("anthropic").map(m => m.id);
    expect(ids).toContain("claude-fable-5");
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    expect(ids).not.toContain("claude-opus-4-8");
  });
});

describe("mapAnthropicModels", () => {
  it("maps the /v1/models payload to dropdown options, preferring display_name", () => {
    expect(mapAnthropicModels({ data: [
      { id: "claude-new-6", display_name: "Claude New 6" },
      { id: "claude-x", }, // no display_name → id as label
      { id: "   " },       // blank id → dropped
      { nope: true },      // malformed → dropped
    ] })).toEqual([
      { id: "claude-new-6", label: "Claude New 6" },
      { id: "claude-x", label: "claude-x" },
    ]);
  });
  it("returns [] for malformed payloads", () => {
    expect(mapAnthropicModels(null)).toEqual([]);
    expect(mapAnthropicModels({})).toEqual([]);
    expect(mapAnthropicModels({ data: "nope" })).toEqual([]);
  });
});

describe("live-first selection + union validation", () => {
  const key = { id: "k-live-1", provider: "anthropic" };
  afterEach(() => {
    delete process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS;
    delete process.env.CLAWHUB_DISABLE_BYO_LIVE_MODELS;
    vi.unstubAllGlobals();
    _clearLiveModelCacheForTests();
  });

  it("falls back to the static catalog when live is unavailable (default under VITEST)", async () => {
    const sel = await selectableModelsForKey(key, () => "sk-ant-fake");
    expect(sel.source).toBe("catalog");
    expect(sel.models.map(m => m.id)).toContain("claude-fable-5");
  });

  it("prefers the provider's live list when the key can fetch it", async () => {
    process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-brand-new-7", display_name: "Claude Brand New 7" }],
    }), { status: 200 })));
    const sel = await selectableModelsForKey(key, () => "sk-ant-real");
    expect(sel.source).toBe("live");
    expect(sel.models).toEqual([{ id: "claude-brand-new-7", label: "Claude Brand New 7" }]);
  });

  it("validates a live-only model (a new Anthropic release) without a ClawHub change", async () => {
    process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-brand-new-7" }],
    }), { status: 200 })));
    expect(await isModelSelectableForKey(key, "claude-brand-new-7", () => "sk-ant-real")).toBe(true);
  });

  it("validates a catalog model even when the live list omits it (union, not entitlement)", async () => {
    process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS = "1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "claude-brand-new-7" }],
    }), { status: 200 })));
    expect(await isModelSelectableForKey(key, "claude-fable-5", () => "sk-ant-real")).toBe(true);
  });

  it("still rejects a provider-mismatched model (gpt id on a claude key)", async () => {
    expect(await isModelSelectableForKey(key, "gpt-5.1", () => "sk-ant-fake")).toBe(false);
  });

  it("keeps free-text behavior for uncurated providers", async () => {
    expect(await isModelSelectableForKey({ id: "k2", provider: "google" }, "gemini-3-ultra")).toBe(true);
  });

  it("a failed live fetch degrades to static, and a broken unseal never throws", async () => {
    process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS = "1";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    const sel = await selectableModelsForKey({ id: "k-fail", provider: "anthropic" }, () => "sk-ant-x");
    expect(sel.source).toBe("catalog");
    const sel2 = await selectableModelsForKey({ id: "k-throw", provider: "anthropic" }, () => { throw new Error("sealing key changed"); });
    expect(sel2.source).toBe("catalog");
  });
});
