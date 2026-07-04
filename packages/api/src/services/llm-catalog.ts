import { log } from "./logger.js";

// D8 · Open-model routing. Platform-keyed open-model traffic goes through
// OpenRouter PINNED to a named US-jurisdiction host — never a PRC first-party API
// (DeepSeek/Z.ai/Moonshot direct). The subprocessor story outranks the price
// delta (a nickel against a $2 verify SKU is not worth the trust hit). The pin is
// enforced SERVER-SIDE at the gateway: the container names only a model, and the
// gateway injects the `provider` block (only US hosts, no fallback outside them,
// deny data-collection, pinned quantization). A model the catalog doesn't list is
// rejected — a prompt-injected reviewer cannot route itself to an unqualified host.
//
// Qualification is per (model, host, QUANTIZATION): hosts serve different quants
// (fp4 vs fp8), so each entry pins exactly what the bench qualified, and the
// subprocessor table names the HOST, not the aggregator. The whole catalog is
// env-overridable (CLAWHUB_PLATFORM_OPENAI_CATALOG) so ops can re-qualify without
// a deploy. BYO agents are unaffected — their key, their data decision.

export type PlatformProvider = "anthropic" | "openrouter";

/**
 * Which protocol the PLATFORM key speaks. `openrouter` routes system agents
 * through the OpenAI-shaped gateway with US-host pinning; `anthropic` (default)
 * keeps the Anthropic Messages gateway. BYO agents ignore this entirely.
 */
export function platformProvider(): PlatformProvider {
  const p = (process.env.CLAWHUB_PLATFORM_PROVIDER || "anthropic").trim().toLowerCase();
  return p === "openrouter" || p === "openai" ? "openrouter" : "anthropic";
}

// D9 · Capability TIERS (router routes by tier, never by vendor). fast = cheap
// single-shot review/triage; balanced = the verify workhorse (agentic tool loops,
// long context); frontier = the 5% audit + sensitive/high-risk review. The
// diversity-audit (two different-family frontier models + human-escalate) and the
// exact-model admission benches are N3 — Q3 bootstraps one slug per tier.
export type PlatformTier = "fast" | "balanced" | "frontier";
export const PLATFORM_TIERS: PlatformTier[] = ["fast", "balanced", "frontier"];

/** A qualified (model, host, quantization) entry. `id` is the OpenRouter slug. */
export interface CatalogEntry {
  /** OpenRouter model slug, e.g. "deepseek/deepseek-chat-v3.1". */
  id: string;
  /** The capability tier this entry serves (informational; routing uses the env pins). */
  tier?: PlatformTier;
  /** Display name of the pinned US host — this is what the subprocessor table names. */
  host: string;
  /**
   * OpenRouter `provider.only` slugs: the qualified US host(s). A single slug is a
   * hard pin (allow_fallbacks false); multiple = fall back only AMONG qualified US
   * hosts. Never contains a non-US or PRC-first-party slug.
   */
  providerOnly: string[];
  /** Pinned quantization(s) — the exact serve the bench qualified (e.g. ["fp8"]). */
  quantizations?: string[];
  /** Append `:exacto` (tool-call-quality reorder, constrained to `providerOnly`). */
  exacto?: boolean;
  /**
   * Fallback price ($/1M tokens) used ONLY when a response carries no authoritative
   * `usage.cost`. OpenRouter returns `usage.cost` in USD, which the gateway meters
   * directly — this is a backstop so an unpriced response never bills $0.
   */
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

// Default catalog — verified LIVE on OpenRouter's /endpoints route (July 2026).
// DeepInfra (US-HQ San Francisco, no-training, zero-retention) is the pinned host;
// `provider.only:["deepinfra"]` also dodges non-US endpoints (Z.AI/SiliconFlow/
// StreamLake/Alibaba) that also serve these open weights. The bench-gated D9 target
// lineup (GLM-5.2 / DeepSeek V4) is NOT live yet — swap it in via env once it is.
//
// HARNESS SAFETY: DeepSeek V3.1+ is a hybrid think model that returns HTTP 400 in a
// tool-calling loop unless `reasoning_content` is round-tripped (which the codex
// harness strips). So the review/verify DEFAULTS are qwen3-coder (fast) + GLM-4.6
// (balanced) — clean tool-callers with no reasoning-content contract. DeepSeek stays
// in the catalog (routable via env) but is not a default. See docs/review-overhaul-plan.md D9.
const DEFAULT_CATALOG: Record<string, CatalogEntry> = {
  // FAST (single-shot review/triage). qwen3-coder = code-tuned, clean tool-calling.
  "qwen/qwen3-coder": {
    id: "qwen/qwen3-coder", tier: "fast", host: "DeepInfra (US)",
    providerOnly: ["deepinfra"], quantizations: ["fp4"],
    price: { input: 0.30, output: 1.00, cacheRead: 0.08 },
  },
  "meta-llama/llama-3.3-70b-instruct": {
    id: "meta-llama/llama-3.3-70b-instruct", tier: "fast", host: "DeepInfra (US)",
    providerOnly: ["deepinfra"], quantizations: ["fp8"],
    price: { input: 0.10, output: 0.32, cacheRead: 0.03 },
  },
  // BALANCED (the verify workhorse — 30–80-call agentic loops). GLM-5.2 is LIVE + a
  // CLEAN agentic tool-caller (no DeepSeek reasoning-content trap), 1M ctx. Pinned to
  // Fireworks (US) for FULL PRECISION + full context (D9 guardrail #3: verify → Fireworks,
  // not DeepInfra fp4 which truncates). This is THE D9 verify model.
  "z-ai/glm-5.2": {
    id: "z-ai/glm-5.2", tier: "balanced", host: "Fireworks (US)",
    providerOnly: ["fireworks"],
    price: { input: 1.4, output: 4.4, cacheRead: 0.35 },
  },
  // GLM-4.6 — the previous balanced default, kept as a cheaper fp4 fallback (DeepInfra US).
  "z-ai/glm-4.6": {
    id: "z-ai/glm-4.6", tier: "balanced", host: "DeepInfra (US)",
    providerOnly: ["deepinfra"], quantizations: ["fp4"],
    price: { input: 0.43, output: 1.74, cacheRead: 0.11 },
  },
  // DeepSeek V4 family — LIVE + cheapest near-frontier, BUT the CONFIRMED hybrid
  // thinking-mode tool-call trap (400 on a multi-turn tool loop without reasoning_content
  // round-trip; rejects tool_choice=required) makes it UNSAFE for the agentic codex
  // harness. Cataloged (env-routable) for SINGLE-SHOT review only; NOT a default until
  // the review path round-trips reasoning_content / goes single-shot (D9 guardrail #2).
  "deepseek/deepseek-v4-flash": {
    id: "deepseek/deepseek-v4-flash", tier: "fast", host: "DeepInfra (US)",
    providerOnly: ["deepinfra"], quantizations: ["fp4"],
    price: { input: 0.09, output: 0.18, cacheRead: 0.02 },
  },
  "deepseek/deepseek-v4-pro": {
    id: "deepseek/deepseek-v4-pro", tier: "frontier", host: "DeepInfra (US)",
    providerOnly: ["deepinfra"], quantizations: ["fp4"],
    price: { input: 1.3, output: 2.6, cacheRead: 0.33 },
  },
  // FRONTIER-audit closed hedges (two different families) — US first-party, tools OK.
  "google/gemini-2.5-flash": {
    id: "google/gemini-2.5-flash", tier: "frontier", host: "Google AI Studio (US)",
    providerOnly: ["google-ai-studio"], quantizations: ["unknown"],
    price: { input: 0.30, output: 2.50, cacheRead: 0.075 },
  },
  "openai/gpt-5-mini": {
    id: "openai/gpt-5-mini", tier: "frontier", host: "OpenAI (US)",
    providerOnly: ["openai"], quantizations: ["unknown"],
    price: { input: 0.25, output: 2.00, cacheRead: 0.03 },
  },
};

let cachedCatalog: Record<string, CatalogEntry> | null = null;
let cachedCatalogRaw: string | undefined;

/**
 * The active catalog: defaults merged with (and overridable by) the JSON in
 * CLAWHUB_PLATFORM_OPENAI_CATALOG. A malformed override is logged and ignored (the
 * defaults stand) so a bad env var can never open routing to an unqualified host.
 */
export function openModelCatalog(): Record<string, CatalogEntry> {
  const raw = process.env.CLAWHUB_PLATFORM_OPENAI_CATALOG;
  if (raw === cachedCatalogRaw && cachedCatalog) return cachedCatalog;
  cachedCatalogRaw = raw;
  const merged: Record<string, CatalogEntry> = { ...DEFAULT_CATALOG };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<CatalogEntry>>;
      for (const [id, v] of Object.entries(parsed)) {
        const only = Array.isArray(v.providerOnly) ? v.providerOnly.filter(s => typeof s === "string" && s) : [];
        if (!only.length) { log("warn", "catalog_entry_no_provider", { id }); continue; } // never leave `only` empty
        merged[id] = {
          id,
          host: typeof v.host === "string" && v.host ? v.host : only[0],
          providerOnly: only,
          quantizations: Array.isArray(v.quantizations) ? v.quantizations.filter(s => typeof s === "string") : undefined,
          exacto: !!v.exacto,
          price: {
            input: v.price?.input ?? 0, output: v.price?.output ?? 0,
            cacheRead: v.price?.cacheRead, cacheWrite: v.price?.cacheWrite,
          },
        };
      }
    } catch (e) {
      log("warn", "catalog_parse_failed", { err: (e as Error).message });
    }
  }
  cachedCatalog = merged;
  return merged;
}

/** Look up a catalog entry for a model id, tolerating a trailing `:exacto`/variant suffix. */
export function catalogEntry(model: string): CatalogEntry | null {
  if (!model) return null;
  const cat = openModelCatalog();
  if (cat[model]) return cat[model];
  const base = model.split(":")[0]; // strip an OpenRouter variant suffix
  return cat[base] ?? null;
}

/**
 * The server-forced OpenRouter `provider` routing block for an entry (D8). This
 * OVERWRITES anything the container sent — the container cannot widen routing.
 * `only` restricts to the qualified US host(s); `allow_fallbacks` is false for a
 * single pinned host and true only when several qualified US hosts are listed (so
 * a fallback still cannot leave the qualified US set); `data_collection: deny`
 * excludes any provider that would train on / retain inputs.
 */
export function providerBlock(e: CatalogEntry): Record<string, unknown> {
  const block: Record<string, unknown> = {
    only: e.providerOnly,
    allow_fallbacks: e.providerOnly.length > 1,
    data_collection: "deny",
  };
  if (e.quantizations && e.quantizations.length) block.quantizations = e.quantizations;
  return block;
}

/** Apply the `:exacto` variant suffix if the entry opts in and it isn't already present. */
export function modelForRequest(e: CatalogEntry): string {
  return e.exacto && !e.id.includes(":") ? `${e.id}:exacto` : e.id;
}

// The concrete open-model slug pinned to each capability tier (env-overridable, so
// ops re-points a tier after a qualification bench without a deploy). Defaults are
// the Q3 bootstrap; N3 swaps in the benched target lineup.
const TIER_ENV: Record<PlatformTier, string> = {
  fast: "CLAWHUB_PLATFORM_MODEL_FAST",
  balanced: "CLAWHUB_PLATFORM_MODEL_BALANCED",
  frontier: "CLAWHUB_PLATFORM_MODEL_FRONTIER",
};
const TIER_DEFAULT: Record<PlatformTier, string> = {
  // TWO models, live + US-pinned; execution is picked by MODE (review = single-shot,
  // verify = agentic), not by tier:
  //  • fast/review → DeepSeek V4 Flash — cheap single-shot review, the 95% default.
  //  • balanced/verify + frontier/audit → GLM-5.2 (Fireworks, full precision, clean
  //    agentic tool-caller). It runs AGENTIC for verify (the browser loop) and SINGLE-SHOT
  //    when auditing a review — a DIFFERENT family from the V4-Flash primary, which is the
  //    cross-family diversity the audit wants (better than V4 Pro, same family as Flash).
  // DeepSeek V4 Pro stays cataloged (env-routable) but is NOT a default: it can't run the
  // agentic loop (thinking-mode trap) and adds no family-diversity over V4 Flash.
  fast: "deepseek/deepseek-v4-flash",
  balanced: "z-ai/glm-5.2",
  frontier: "z-ai/glm-5.2",
};

/** The open-model slug for a capability tier. Also honors the legacy
 *  CLAWHUB_PLATFORM_REVIEW_MODEL_CHEAP/STRONG for fast/balanced back-compat. */
export function platformModelForTier(tier: PlatformTier): string {
  const legacy = tier === "fast" ? process.env.CLAWHUB_PLATFORM_REVIEW_MODEL_CHEAP
    : tier === "balanced" ? process.env.CLAWHUB_PLATFORM_REVIEW_MODEL_STRONG : undefined;
  return process.env[TIER_ENV[tier]] || legacy || TIER_DEFAULT[tier];
}

/** Map the risk router's decision to a capability tier: an audit sample → frontier,
 *  else high/sensitive (the "sonnet" alias) → balanced, low/medium → fast. */
export function reviewTier(tierAlias: "haiku" | "sonnet", audited: boolean): PlatformTier {
  if (audited) return "frontier";
  return tierAlias === "sonnet" ? "balanced" : "fast";
}

/** Fallback price → integer micro-USD, used only when a response carries no usage.cost. */
export function catalogPriceMicroUsd(e: CatalogEntry, u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
  const per = (usd: number) => usd / 1_000_000;
  const usd =
    u.inputTokens * per(e.price.input) +
    u.outputTokens * per(e.price.output) +
    (u.cacheReadTokens ?? 0) * per(e.price.cacheRead ?? e.price.input * 0.25) +
    (u.cacheWriteTokens ?? 0) * per(e.price.cacheWrite ?? e.price.input);
  return Math.ceil(usd * 1_000_000);
}
