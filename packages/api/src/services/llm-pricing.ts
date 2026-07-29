import { log } from "./logger.js";

// Platform LLM pricing (M3 metering). Prices are USD per MILLION tokens; the
// gateway prices each request into integer MICRO-USD (1e-6 USD) so there is no
// float drift in the billing ledger. Anthropic pricing verified July 2026
// (strategy §4): Haiku 4.5 $1/$5; Sonnet 5 $3/$15 (intro $2/$10 through
// 2026-08-31 — see the M5 calendar item to re-baseline); cache reads 0.1×,
// cache writes 1.25×. Overridable at runtime with CLAWHUB_PLATFORM_MODEL_PRICES
// (a JSON map, so ops can correct a price without a deploy — D6).

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-READ tokens (0.1× input for Anthropic). */
  cacheRead: number;
  /** USD per 1M cache-WRITE tokens (1.25× input for Anthropic). */
  cacheWrite: number;
}

// Keyed by a normalized model family. `resolveModelPrice` matches an incoming
// model id (e.g. "claude-haiku-4-5-20251001" or a bare "sonnet") to a family.
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  haiku: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  // Intro pricing (through 2026-08-31). Flip to 3/15 + cacheRead 0.3 after.
  sonnet: { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  opus: { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  // Open-weights balanced/high-tier candidate (D7). GLM-5.2 $1.40/$4.40, cached in 0.26.
  glm: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 1.75 },
};

let cachedOverrides: Record<string, ModelPrice> | null = null;
let cachedOverrideRaw: string | undefined;

function overrides(): Record<string, ModelPrice> {
  const raw = process.env.CLAWHUB_PLATFORM_MODEL_PRICES;
  if (raw === cachedOverrideRaw) return cachedOverrides ?? {};
  cachedOverrideRaw = raw;
  cachedOverrides = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
      for (const [k, v] of Object.entries(parsed)) {
        cachedOverrides[k.toLowerCase()] = {
          input: v.input ?? 0, output: v.output ?? 0,
          cacheRead: v.cacheRead ?? (v.input ?? 0) * 0.1,
          cacheWrite: v.cacheWrite ?? (v.input ?? 0) * 1.25,
        };
      }
    } catch (e) {
      log("warn", "model_prices_parse_failed", { err: (e as Error).message });
    }
  }
  return cachedOverrides;
}

/** Map an arbitrary model id to its price family (defaults + env overrides). */
export function resolveModelPrice(model: string): ModelPrice {
  const m = (model || "").toLowerCase();
  const table = { ...DEFAULT_PRICES, ...overrides() };
  // Exact key wins (an override can name a full id), then family substring.
  if (table[m]) return table[m];
  for (const family of Object.keys(table)) {
    if (m.includes(family)) return table[family];
  }
  // Unknown model → price at Sonnet (never undercharge on an unrecognized id).
  return table.sonnet ?? DEFAULT_PRICES.sonnet;
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Price a usage into integer micro-USD (1e-6 USD). Deterministic; rounds up. */
export function priceUsageMicroUsd(model: string, u: UsageTokens): number {
  const p = resolveModelPrice(model);
  // Prices are USD per 1M tokens, so `tokens * price` already yields the cost in
  // MICRO-USD — the ÷1e6 (tokens→USD) and the ×1e6 (USD→micro) cancel exactly.
  // Computing in the micro domain directly avoids the divide-then-multiply
  // round-trip, whose residual float error survived into the ledger and inflated
  // even EXACT charges by a micro (e.g. glm 1000 in + 1000 out priced 5801, not
  // the true 5800) once Math.ceil rounded the 5800.0000000001 artifact up.
  const micro =
    u.inputTokens * p.input +
    u.outputTokens * p.output +
    (u.cacheReadTokens ?? 0) * p.cacheRead +
    (u.cacheWriteTokens ?? 0) * p.cacheWrite;
  // Snap sub-micro float noise to zero before rounding up, so Math.ceil only ever
  // charges for a GENUINE fractional micro, never a floating-point artifact.
  return Math.ceil(Number(micro.toFixed(6)));
}

/** Micro-USD → integer cents (rounded up) for the cost_ledger mirror. */
export function microUsdToCents(micro: number): number {
  return Math.ceil(micro / 10_000);
}
