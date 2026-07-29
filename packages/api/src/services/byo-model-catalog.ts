// [issues] #72 — model selection for BYO (bring-your-own-key) deployments.
//
// The existing `llm-catalog.ts` is shaped for the PLATFORM-metered path (an
// OpenRouter-qualified, US-host-pinned catalog) — it has nothing to do with
// which models a user's own Claude/OpenAI key can run. This is the BYO-side
// counterpart, TWO layers deep:
//   1. LIVE (anthropic): the provider's own models API, called WITH the user's
//      sealed key (`GET https://api.anthropic.com/v1/models`) — it returns
//      exactly the models THAT key can use, so a new Anthropic model shows up
//      in the dropdown with no ClawHub change at all. Cached per key, short TTL.
//   2. STATIC fallback: a small provider-keyed list, operator-correctable via
//      CLAWHUB_BYO_MODEL_CATALOG (same override pattern as the platform
//      catalog), used when the live call fails (invalid key, subscription
//      sk-ant-oat tokens the models API rejects, network egress disabled) or
//      for providers with no sane live listing (OpenAI's /v1/models returns
//      every embedding/tts/moderation model — uncurated noise for a dropdown).
// VALIDATION accepts the UNION of live + static: the check exists to catch a
// provider mismatch (a Claude key pinned to a GPT id), not to police
// entitlements — a model in either list is provider-consistent.
// Kill switch: CLAWHUB_DISABLE_BYO_LIVE_MODELS=1 (static only — for self-hosts
// that do not want the API process calling out to api.anthropic.com).

export interface ByoModelOption {
  id: string;
  label: string;
}

const DEFAULT_BYO_MODEL_CATALOG: Record<string, ByoModelOption[]> = {
  anthropic: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5.1", label: "GPT-5.1" },
    { id: "gpt-5.1-mini", label: "GPT-5.1 mini" },
    { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  ],
};

let cached: Record<string, ByoModelOption[]> | null = null;
let cachedRaw: string | undefined;

/**
 * The active BYO model catalog: defaults merged with (and overridable by) the
 * JSON in CLAWHUB_BYO_MODEL_CATALOG, e.g. `{"anthropic":[{"id":"...","label":"..."}]}`.
 * A malformed override is ignored (defaults stand) — never throws.
 */
export function byoModelCatalog(): Record<string, ByoModelOption[]> {
  const raw = process.env.CLAWHUB_BYO_MODEL_CATALOG;
  if (raw === cachedRaw && cached) return cached;
  cachedRaw = raw;
  const merged: Record<string, ByoModelOption[]> = { ...DEFAULT_BYO_MODEL_CATALOG };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Array<{ id?: string; label?: string }>>;
      for (const [provider, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue;
        const opts = list
          .filter((m): m is { id: string; label?: string } => typeof m?.id === "string" && m.id.trim().length > 0)
          .map(m => ({ id: m.id.trim(), label: (m.label ?? m.id).trim() }));
        if (opts.length) merged[provider] = opts;
      }
    } catch {
      // ignored — defaults stand
    }
  }
  cached = merged;
  return merged;
}

/**
 * Normalize a raw `llm_keys.provider` value to a catalog lookup key. Unlike
 * the runtime dispatch normalization elsewhere (which defaults an unknown
 * provider to "anthropic" so the harness always has a CLI to hand the key
 * to), an uncurated provider here must NOT silently borrow another
 * provider's model list — it falls through to "other" (⇒ empty, free-text).
 */
export function normalizeByoProvider(provider: string): string {
  if (provider === "openai" || provider === "openrouter") return "openai";
  if (provider === "anthropic" || provider === "google") return provider;
  return "other";
}

/** Selectable models for a key's provider — empty when the provider has no curated catalog (free-text model field). */
export function byoModelsForProvider(provider: string): ByoModelOption[] {
  return byoModelCatalog()[normalizeByoProvider(provider)] ?? [];
}

// --- Live layer -------------------------------------------------------------

/** The shape `GET /v1/models` returns (both Anthropic and OpenAI use data[]). */
interface ProviderModelsPayload { data?: Array<{ id?: string; display_name?: string }> }

/** Pure: map an Anthropic /v1/models payload to dropdown options (exported for tests). */
export function mapAnthropicModels(payload: unknown): ByoModelOption[] {
  const data = (payload as ProviderModelsPayload | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m): m is { id: string; display_name?: string } => typeof m?.id === "string" && m.id.trim().length > 0)
    .map(m => ({ id: m.id.trim(), label: (m.display_name ?? m.id).trim() }))
    .slice(0, 50);
}

// Per-key cache so the dropdown + the create/edit validations don't each hit the
// provider. Successes live 10 min (a new model appearing a few minutes late is
// fine); failures 60s (a typo'd key shouldn't hammer the provider, but a fixed
// one should recover fast). Keyed by the vault row id, module-local like the
// static catalog cache above.
const LIVE_TTL_OK_MS = 10 * 60_000;
const LIVE_TTL_FAIL_MS = 60_000;
const liveCache = new Map<string, { at: number; models: ByoModelOption[] | null }>();

function liveDisabled(): boolean {
  if (process.env.CLAWHUB_DISABLE_BYO_LIVE_MODELS === "1") return true;
  // Never call a real provider from the test runner; a test that wants the live
  // path stubs global fetch and sets the force flag.
  if (process.env.VITEST && process.env.CLAWHUB_FORCE_BYO_LIVE_MODELS !== "1") return true;
  return false;
}

/**
 * The models THIS key can use, straight from the provider — anthropic only for
 * now (see the header). null = live listing unavailable (fall back to static).
 * Never throws; 5s timeout so a slow provider can't hang the dropdown.
 */
async function liveModelsForKey(key: { id: string; provider: string }, apiKey: string): Promise<ByoModelOption[] | null> {
  if (liveDisabled()) return null;
  if (normalizeByoProvider(key.provider) !== "anthropic") return null;
  const hit = liveCache.get(key.id);
  if (hit && Date.now() - hit.at < (hit.models ? LIVE_TTL_OK_MS : LIVE_TTL_FAIL_MS)) return hit.models;
  let models: ByoModelOption[] | null = null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const mapped = mapAnthropicModels(await res.json());
      if (mapped.length) models = mapped;
    }
  } catch { /* network/timeout — fall back to static */ }
  liveCache.set(key.id, { at: Date.now(), models });
  return models;
}

/** Test hook: clear the per-key live cache. */
export function _clearLiveModelCacheForTests(): void { liveCache.clear(); }

export interface SelectableModels { models: ByoModelOption[]; source: "live" | "catalog" }

/**
 * What the model dropdown for a vault key should show: the provider's LIVE list
 * for this key when obtainable, else the static catalog. `unsealKey` is passed
 * in (not imported) so this module stays pure/testable and callers that only
 * have a redacted row simply omit it.
 */
export async function selectableModelsForKey(
  key: { id: string; provider: string },
  unsealKey?: () => string,
): Promise<SelectableModels> {
  if (unsealKey) {
    let apiKey = "";
    try { apiKey = unsealKey(); } catch { /* sealing key changed — static fallback */ }
    if (apiKey) {
      const live = await liveModelsForKey(key, apiKey);
      if (live) return { models: live, source: "live" };
    }
  }
  return { models: byoModelsForProvider(key.provider), source: "catalog" };
}

/**
 * Create/edit validation: is this model plausible for this key? True when the
 * model is in the LIVE list OR the static catalog (union — see the header), or
 * when both lists are empty (uncurated provider ⇒ free-text, unchanged).
 */
export async function isModelSelectableForKey(
  key: { id: string; provider: string },
  model: string,
  unsealKey?: () => string,
): Promise<boolean> {
  const catalog = byoModelsForProvider(key.provider);
  if (catalog.some(m => m.id === model)) return true;
  let live: ByoModelOption[] | null = null;
  if (unsealKey) {
    let apiKey = "";
    try { apiKey = unsealKey(); } catch { /* static-only */ }
    if (apiKey) live = await liveModelsForKey(key, apiKey);
  }
  if (live?.some(m => m.id === model)) return true;
  // Nothing curated AND nothing live ⇒ free-text provider — accept anything.
  return catalog.length === 0 && !live?.length;
}
