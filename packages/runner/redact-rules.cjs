"use strict";

/**
 * Mask secret values in whatever this runner reports back (#142).
 *
 * Defense in depth: the API masks authoritatively at the sink (it is the only
 * process that can unseal the run's secrets, so a stale or hostile runner can't
 * bypass it). Masking HERE additionally keeps plaintext from crossing the wire
 * at all — including into the live-tail snapshots the log-flush timer ships
 * every few seconds while a run streams.
 *
 * Mirrors packages/api/src/services/log-redact.ts. Kept as a dependency-free
 * .cjs rules module (like live-log-rules.cjs / infra-hosts.cjs) so it is unit
 * testable with `node --test` and importable from the ESM entrypoint.
 */

const REDACTED = "***";
const MIN_SECRET_LENGTH = 6;
const MAX_VALUES = 64;
const MAX_PAIR_VALUES = 16;

// Commonly present in a secret bag, never secret-ish. Masking these would turn
// ordinary log text into `***` soup and bury the signal the log exists for.
const DENY_VALUES = new Set([
  "true", "false", "yes", "no", "null", "none", "undefined", "default",
  "production", "development", "staging", "test", "testing", "debug",
  "latest", "stable", "main", "master", "localhost", "enabled", "disabled",
]);

function isMaskableValue(value) {
  if (typeof value !== "string") return false;
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (DENY_VALUES.has(value.trim().toLowerCase())) return false;
  return true;
}

/**
 * Expand each value into the literal strings a log realistically carries it as:
 * the raw value, its base64/base64url spellings, its URL-encoded form, and
 * `base64(a:b)` for every ordered pair (the docker-config shape a registry login
 * writes — raw-substring matching alone would miss it). Longest-first so a
 * composite is replaced before the value nested inside it.
 */
function redactionPatterns(values) {
  const uniq = [];
  const seen = new Set();
  for (const v of values || []) {
    if (!isMaskableValue(v) || seen.has(v)) continue;
    seen.add(v);
    uniq.push(v);
    if (uniq.length >= MAX_VALUES) break;
  }

  const out = new Set();
  const add = s => { if (s.length >= MIN_SECRET_LENGTH) out.add(s); };
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
function redactSecrets(text, patterns) {
  if (!text || !patterns || patterns.length === 0) return text;
  let out = text;
  for (const p of patterns) {
    if (!out.includes(p)) continue;
    out = out.split(p).join(REDACTED);
  }
  return out;
}

/**
 * The same masking over an arbitrary JSON value — `stepResults` carries up to
 * 8000 chars of raw stdout/stderr per step and is an independent sink from
 * rawLogs. Object KEYS are secret NAMES, never values, so they're left alone.
 */
function redactDeep(value, patterns) {
  if (!patterns || patterns.length === 0) return value;
  if (typeof value === "string") return redactSecrets(value, patterns);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, patterns));
  if (value && typeof value === "object") {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redactDeep(v, patterns);
    return o;
  }
  return value;
}

module.exports = { REDACTED, MIN_SECRET_LENGTH, isMaskableValue, redactionPatterns, redactSecrets, redactDeep };
