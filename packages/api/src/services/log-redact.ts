/**
 * Best-effort masking of secret values in CI run output (#142).
 *
 * ClawHub binds the DELIVERY of run secrets tightly (constant-time runnerToken
 * compare, claimed-run gate, agent Bearer, standing-run owner binding) — but
 * whatever a run PRINTS used to be stored and served verbatim at repo READ.
 * That inverted the privilege: writing a secret needs repo admin, receiving one
 * needs a claimed run + an agent identity, reading one back out of a log needed
 * only `read` (which on a public repo is any signed-up user, and on a private
 * repo includes the low-trust `reviewer` tier).
 *
 * This module is the pure half of the fix: given the run's secret VALUES, turn
 * text (and any JSON blob) into the same text with those values — and their
 * common encodings — replaced by `***`.
 *
 * Deliberate limits, documented in docs/ci.md:
 *   - Masking is a SAFETY NET, not a licence to print secrets. A step can always
 *     transform a value past recognition (`echo $TOK | rev`, gzip, chunking).
 *   - Values shorter than MIN_SECRET_LENGTH or on the deny-list are skipped, so
 *     a secret set containing `DEBUG=1` doesn't redact every `1` in the log.
 */

export const REDACTED = "***";

/** Values shorter than this are never masked — too likely to be ordinary text. */
export const MIN_SECRET_LENGTH = 6;

/**
 * Values that are commonly held in a secret bag but are not secret-ish. Matching
 * these would turn ordinary log text into `***` soup and hide the real signal.
 */
const DENY_VALUES = new Set([
  "true", "false", "yes", "no", "null", "none", "undefined", "default",
  "production", "development", "staging", "test", "testing", "debug",
  "latest", "stable", "main", "master", "localhost", "enabled", "disabled",
]);

/** Bound the work a hostile/huge secret set can force on the log sink. */
const MAX_VALUES = 64;
/** `base64(user:token)` pairs are O(n²) — only generated for a small set. */
const MAX_PAIR_VALUES = 16;

/** Is this value worth masking at all? */
export function isMaskableValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (DENY_VALUES.has(value.trim().toLowerCase())) return false;
  return true;
}

/**
 * Expand each secret value into the literal strings a log realistically carries
 * it as. Beyond the raw value:
 *   - `base64(value)` and its base64url spelling — a token written into a config;
 *   - `base64(a:b)` for every ordered pair of values — the docker-config shape
 *     (`scripts/ci/build-harness-arch.sh` writes `base64(GHCR_USER:GHCR_TOKEN)`),
 *     which raw-substring matching alone would miss entirely;
 *   - `encodeURIComponent(value)` — a token spliced into a URL or form body.
 *
 * Returned longest-first so a composite pattern is replaced before the value it
 * contains (otherwise the inner match would shred the outer one into `***`-noise
 * and leave the rest of the composite intact).
 */
export function redactionPatterns(values: Iterable<string>): string[] {
  const uniq: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!isMaskableValue(v) || seen.has(v)) continue;
    seen.add(v);
    uniq.push(v);
    if (uniq.length >= MAX_VALUES) break;
  }

  const out = new Set<string>();
  const add = (s: string) => { if (s.length >= MIN_SECRET_LENGTH) out.add(s); };

  for (const v of uniq) {
    add(v);
    add(Buffer.from(v, "utf8").toString("base64"));
    add(Buffer.from(v, "utf8").toString("base64url"));
    add(encodeURIComponent(v));
  }

  const pairSrc = uniq.slice(0, MAX_PAIR_VALUES);
  for (const a of pairSrc) {
    for (const b of pairSrc) {
      if (a === b) continue;
      add(Buffer.from(`${a}:${b}`, "utf8").toString("base64"));
    }
  }

  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** Replace every pattern occurrence in `text` with `***`. */
export function redactSecrets(text: string, patterns: string[]): { text: string; count: number } {
  if (!text || patterns.length === 0) return { text, count: 0 };
  let out = text;
  let count = 0;
  for (const p of patterns) {
    if (!out.includes(p)) continue;
    const parts = out.split(p);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  return { text: out, count };
}

/**
 * Same masking over an arbitrary JSON value — `ci_runs.stepResults` is the
 * SECOND, independent sink (up to 8000 chars of raw stdout/stderr per step), so
 * a fix that only touched the log blob would leave it wide open. Object KEYS are
 * secret NAMES (`GHCR_TOKEN`), never values, so they are left alone.
 */
export function redactDeep<T>(value: T, patterns: string[]): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v, patterns);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
