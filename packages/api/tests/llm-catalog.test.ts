import { describe, it, expect, afterEach } from "vitest";
import {
  platformProvider, catalogEntry, providerBlock, modelForRequest, catalogPriceMicroUsd,
  openModelCatalog, platformModelForTier, reviewTier, type CatalogEntry,
} from "../src/services/llm-catalog.js";

// D8/D9 — the US-pinned open-model catalog + the tier router. The provider block is
// the load-bearing security control (a container can't route off a qualified US host),
// so it gets the most scrutiny.

const ENV_KEYS = [
  "CLAWHUB_PLATFORM_PROVIDER", "CLAWHUB_PLATFORM_OPENAI_CATALOG",
  "CLAWHUB_PLATFORM_MODEL_FAST", "CLAWHUB_PLATFORM_MODEL_BALANCED", "CLAWHUB_PLATFORM_MODEL_FRONTIER",
  "CLAWHUB_PLATFORM_REVIEW_MODEL_CHEAP", "CLAWHUB_PLATFORM_REVIEW_MODEL_STRONG",
];
const saved: Record<string, string | undefined> = {};
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; delete saved[k]; } });
function setEnv(k: string, v: string | undefined) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }

describe("platformProvider", () => {
  it("defaults to anthropic; openrouter/openai → openrouter", () => {
    setEnv("CLAWHUB_PLATFORM_PROVIDER", undefined); expect(platformProvider()).toBe("anthropic");
    setEnv("CLAWHUB_PLATFORM_PROVIDER", "openrouter"); expect(platformProvider()).toBe("openrouter");
    setEnv("CLAWHUB_PLATFORM_PROVIDER", "OpenAI"); expect(platformProvider()).toBe("openrouter");
    setEnv("CLAWHUB_PLATFORM_PROVIDER", "garbage"); expect(platformProvider()).toBe("anthropic");
  });
});

describe("providerBlock (D8 US pin)", () => {
  it("single host → hard pin (no fallbacks), deny data collection, pins quant", () => {
    const e: CatalogEntry = { id: "x", host: "H", providerOnly: ["deepinfra"], quantizations: ["fp4"], price: { input: 1, output: 1 } };
    const b = providerBlock(e);
    expect(b.only).toEqual(["deepinfra"]);
    expect(b.allow_fallbacks).toBe(false);        // one host = never spill
    expect(b.data_collection).toBe("deny");        // exclude training providers
    expect(b.quantizations).toEqual(["fp4"]);
  });
  it("multiple qualified hosts → fallback allowed but only among them", () => {
    const e: CatalogEntry = { id: "x", host: "H", providerOnly: ["deepinfra", "fireworks"], price: { input: 1, output: 1 } };
    const b = providerBlock(e);
    expect(b.allow_fallbacks).toBe(true);
    expect(b.only).toEqual(["deepinfra", "fireworks"]);
  });
  it("omits quantizations when unset", () => {
    expect(providerBlock({ id: "x", host: "H", providerOnly: ["deepinfra"], price: { input: 1, output: 1 } }).quantizations).toBeUndefined();
  });
});

describe("catalogEntry lookup", () => {
  it("resolves a default live model + tolerates an :exacto suffix", () => {
    expect(catalogEntry("qwen/qwen3-coder")?.host).toContain("US");
    expect(catalogEntry("qwen/qwen3-coder:exacto")?.id).toBe("qwen/qwen3-coder");
  });
  it("returns null for an uncatalogued model (→ gateway 400)", () => {
    expect(catalogEntry("deepseek/deepseek-chat")).toBeNull();      // not in catalog
    expect(catalogEntry("gpt-4o")).toBeNull();
    expect(catalogEntry("")).toBeNull();
  });
  it("never pins a non-US / PRC-first-party host by default", () => {
    for (const e of Object.values(openModelCatalog())) {
      for (const p of e.providerOnly) {
        expect(["z-ai", "siliconflow", "streamlake", "alibaba", "novita"]).not.toContain(p);
      }
    }
  });
});

describe("openModelCatalog env override", () => {
  it("merges a valid override entry", () => {
    setEnv("CLAWHUB_PLATFORM_OPENAI_CATALOG", JSON.stringify({ "acme/model": { host: "Acme (US)", providerOnly: ["acme"], price: { input: 0.5, output: 1 } } }));
    expect(catalogEntry("acme/model")?.host).toBe("Acme (US)");
  });
  it("ignores an entry with no providerOnly (never leaves routing un-pinned)", () => {
    setEnv("CLAWHUB_PLATFORM_OPENAI_CATALOG", JSON.stringify({ "bad/model": { host: "X", price: { input: 1, output: 1 } } }));
    expect(catalogEntry("bad/model")).toBeNull();
  });
  it("survives malformed JSON (defaults stand)", () => {
    setEnv("CLAWHUB_PLATFORM_OPENAI_CATALOG", "{not json");
    expect(catalogEntry("qwen/qwen3-coder")).not.toBeNull();
  });
});

describe("tier router (D9)", () => {
  it("maps risk decision → tier: audit→frontier, sonnet→balanced, haiku→fast", () => {
    expect(reviewTier("haiku", false)).toBe("fast");
    expect(reviewTier("sonnet", false)).toBe("balanced");
    expect(reviewTier("haiku", true)).toBe("frontier");   // audit sample beats tier
    expect(reviewTier("sonnet", true)).toBe("frontier");
  });
  it("defaults are live + harness-safe (NOT DeepSeek, whose thinking-mode 400s a tool loop)", () => {
    setEnv("CLAWHUB_PLATFORM_MODEL_FAST", undefined);
    setEnv("CLAWHUB_PLATFORM_MODEL_BALANCED", undefined);
    expect(platformModelForTier("fast")).toBe("qwen/qwen3-coder");
    expect(platformModelForTier("balanced")).toBe("z-ai/glm-4.6");
    expect(platformModelForTier("balanced")).not.toContain("deepseek");
  });
  it("env pins override the default per tier", () => {
    setEnv("CLAWHUB_PLATFORM_MODEL_BALANCED", "z-ai/glm-5.2");
    expect(platformModelForTier("balanced")).toBe("z-ai/glm-5.2");
  });
  it("honors the legacy CHEAP/STRONG env for fast/balanced", () => {
    setEnv("CLAWHUB_PLATFORM_MODEL_FAST", undefined);
    setEnv("CLAWHUB_PLATFORM_REVIEW_MODEL_CHEAP", "legacy/cheap");
    expect(platformModelForTier("fast")).toBe("legacy/cheap");
  });
});

describe("modelForRequest + pricing fallback", () => {
  it("adds :exacto only when the entry opts in", () => {
    expect(modelForRequest({ id: "a/b", host: "H", providerOnly: ["x"], price: { input: 1, output: 1 } })).toBe("a/b");
    expect(modelForRequest({ id: "a/b", host: "H", providerOnly: ["x"], exacto: true, price: { input: 1, output: 1 } })).toBe("a/b:exacto");
  });
  it("catalogPriceMicroUsd prices input+output (fallback when no usage.cost)", () => {
    const e: CatalogEntry = { id: "x", host: "H", providerOnly: ["x"], price: { input: 1, output: 2 } };  // $/M
    // 1M input @ $1 + 1M output @ $2 = $3 = 3_000_000 micro-USD.
    expect(catalogPriceMicroUsd(e, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3_000_000);
  });
});
