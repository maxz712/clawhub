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
