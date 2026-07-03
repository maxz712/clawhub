import { describe, it, expect, afterEach } from "vitest";
import { resolveModelPrice, priceUsageMicroUsd, microUsdToCents } from "../src/services/llm-pricing.js";
import { hashGatewayToken } from "../src/services/llm-gateway.js";

afterEach(() => { delete process.env.CLAWHUB_PLATFORM_MODEL_PRICES; });

describe("resolveModelPrice", () => {
  it("matches model families by substring", () => {
    expect(resolveModelPrice("claude-haiku-4-5-20251001").input).toBe(1.0);
    expect(resolveModelPrice("sonnet").input).toBe(2.0); // intro pricing
    expect(resolveModelPrice("claude-opus-4-8").output).toBe(25.0);
  });
  it("falls back to Sonnet pricing for unknown models (never undercharge)", () => {
    expect(resolveModelPrice("some-unknown-model")).toEqual(resolveModelPrice("sonnet"));
  });
  it("honors CLAWHUB_PLATFORM_MODEL_PRICES overrides", () => {
    process.env.CLAWHUB_PLATFORM_MODEL_PRICES = JSON.stringify({ haiku: { input: 9, output: 9 } });
    const p = resolveModelPrice("claude-haiku-4-5");
    expect(p.input).toBe(9);
    expect(p.cacheRead).toBeCloseTo(0.9); // derived 0.1× when not given
  });
});

describe("priceUsageMicroUsd", () => {
  it("prices input+output+cache into micro-USD", () => {
    // Haiku: 1M input @ $1 = $1 = 1_000_000 micro-USD; 1M output @ $5 = 5_000_000.
    const micro = priceUsageMicroUsd("haiku", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(micro).toBe(6_000_000);
  });
  it("charges cache reads at the reduced rate", () => {
    // Haiku cacheRead $0.1/MTok → 1M cache-read tokens = $0.10 = 100_000 micro-USD.
    const micro = priceUsageMicroUsd("haiku", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    expect(micro).toBe(100_000);
  });
  it("a realistic blended review is well under a cent", () => {
    // ~12k output + 30k input + 10k cache-read on Haiku — the strategy's ~$0.046.
    const micro = priceUsageMicroUsd("haiku", { inputTokens: 30_000, outputTokens: 12_000, cacheReadTokens: 10_000 });
    expect(micro).toBeLessThan(100_000); // < $0.10
    expect(micro).toBeGreaterThan(0);
  });
});

describe("microUsdToCents", () => {
  it("rounds micro-USD up to whole cents", () => {
    expect(microUsdToCents(6_000_000)).toBe(600); // $6.00 → 600¢
    expect(microUsdToCents(1)).toBe(1);           // sub-cent rounds up to 1¢
    expect(microUsdToCents(0)).toBe(0);
  });
});

describe("hashGatewayToken", () => {
  it("is a stable sha256 hex digest", () => {
    const h = hashGatewayToken("chgw_abc");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGatewayToken("chgw_abc")).toBe(h);
    expect(hashGatewayToken("chgw_xyz")).not.toBe(h);
  });
});
