// [issues] #72 — model selection for BYO (bring-your-own-key) deployments.
//
// The existing `llm-catalog.ts` is shaped for the PLATFORM-metered path (an
// OpenRouter-qualified, US-host-pinned catalog) — it has nothing to do with
// which models a user's own Claude/OpenAI key can run. This is the BYO-side
// counterpart: a small, provider-keyed list of selectable model ids, "auto
// detected" from the key's `provider` column (no live network probe — the
// list is static + operator-correctable via env, matching the
// CLAWHUB_PLATFORM_OPENAI_CATALOG override pattern so a renamed/retired model
// id doesn't need a deploy to fix).

export interface ByoModelOption {
  id: string;
  label: string;
}

const DEFAULT_BYO_MODEL_CATALOG: Record<string, ByoModelOption[]> = {
  anthropic: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
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
