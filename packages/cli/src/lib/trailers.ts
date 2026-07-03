// Deterministic ClawHub trailer composition — the tool-side emission that makes
// trailers a progressive enhancement instead of a convention agents must
// remember (M2 of the review overhaul). Mirrors the server parser in
// packages/api/src/services/trailer-parser.ts; kept in sync by round-tripping
// through the public POST /playground/parse endpoint in the MCP validate tool.

export type Risk = "low" | "medium" | "high" | "critical";
export const RISKS: Risk[] = ["low", "medium", "high", "critical"];

export interface TrailerInput {
  intent?: string;
  risk?: Risk;
  scope?: string[];
  reviewFocus?: string[]; // raw "path:start-end — note" lines
  closes?: number[];
  agent?: string;
}

/** The recognized trailer keys, so we can detect an already-composed message. */
const TRAILER_KEYS = ["Intent", "Risk", "Scope", "Review-Focus", "Closes", "Agent", "Draft"];

/** True when a commit message already carries a ClawHub trailer block. */
export function hasTrailers(message: string): boolean {
  return message.split(/\r?\n/).some(l => {
    const m = l.match(/^([A-Z][A-Za-z-]+):\s*(.+)$/);
    return !!m && TRAILER_KEYS.includes(m[1]);
  });
}

/** Which recognized trailer keys are already present. */
export function presentKeys(message: string): Set<string> {
  const keys = new Set<string>();
  for (const l of message.split(/\r?\n/)) {
    const m = l.match(/^([A-Z][A-Za-z-]+):\s*(.+)$/);
    if (m && TRAILER_KEYS.includes(m[1])) keys.add(m[1]);
  }
  return keys;
}

/**
 * Compose the trailer block (no leading blank line). `Risk` defaults to low
 * (declared risk is only a floor — the server computes the real risk). Order is
 * stable: Intent, Risk, Scope, Review-Focus, Closes, Agent.
 */
export function composeTrailerBlock(t: TrailerInput): string {
  const lines: string[] = [];
  if (t.intent) lines.push(`Intent: ${t.intent.trim()}`);
  lines.push(`Risk: ${t.risk ?? "low"}`);
  const scope = (t.scope ?? []).map(s => s.trim()).filter(Boolean);
  if (scope.length) lines.push(`Scope: ${scope.join(", ")}`);
  for (const rf of t.reviewFocus ?? []) if (rf.trim()) lines.push(`Review-Focus: ${rf.trim()}`);
  for (const n of t.closes ?? []) if (Number.isFinite(n)) lines.push(`Closes: #${n}`);
  if (t.agent) lines.push(`Agent: ${t.agent.trim()}`);
  return lines.join("\n");
}

/**
 * Build a full commit message: subject, optional prose body, then the trailer
 * block separated by a blank line. If `existing` already carries trailers, only
 * the keys NOT already present are appended (idempotent — re-running never
 * duplicates a trailer).
 */
export function composeCommitMessage(subject: string, body: string | undefined, t: TrailerInput): string {
  const block = composeTrailerBlock(t);
  const parts = [subject.trim()];
  if (body && body.trim()) parts.push("", body.trim());
  parts.push("", block);
  return parts.join("\n") + "\n";
}

/** Prose body of a commit message: everything after the subject with the
 *  trailing trailer block removed. Mirrors the server's stripTrailerBlock. */
export function stripTrailerBlock(message: string): string {
  const lines = message.split(/\r?\n/).slice(1);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  let end = lines.length;
  while (end > 0) {
    const l = lines[end - 1];
    if (l.trim() === "" || /^([A-Z][A-Za-z-]+):\s*(.+)$/.test(l)) { end--; continue; }
    break;
  }
  const tail = lines.slice(end);
  const kept = tail.some(l => /^([A-Z][A-Za-z-]+):\s*(.+)$/.test(l)) ? lines.slice(0, end) : lines;
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  while (kept.length && kept[0].trim() === "") kept.shift();
  return kept.join("\n").trim();
}

/** Parse the ClawHub trailer VALUES out of an existing message (for --amend merge). */
export function parseTrailerValues(message: string): TrailerInput {
  const raw: Record<string, string[]> = {};
  for (const l of message.split(/\r?\n/)) {
    const m = l.match(/^([A-Z][A-Za-z-]+):\s*(.+)$/);
    if (m && TRAILER_KEYS.includes(m[1])) (raw[m[1]] ??= []).push(m[2].trim());
  }
  const risk = raw["Risk"]?.[0]?.toLowerCase();
  return {
    intent: raw["Intent"]?.[0],
    risk: (RISKS as string[]).includes(risk ?? "") ? risk as Risk : undefined,
    scope: (raw["Scope"] ?? []).flatMap(v => v.split(",")).map(s => s.trim()).filter(Boolean),
    reviewFocus: raw["Review-Focus"] ?? [],
    closes: (raw["Closes"] ?? []).flatMap(v => v.split(/[\s,]+/)).map(s => Number(s.replace(/^#/, ""))).filter(n => Number.isFinite(n)),
    agent: raw["Agent"]?.[0],
  };
}

/** Merge B over A (B's set fields win; scope/focus/closes replace, not concat). */
export function mergeTrailers(a: TrailerInput, b: TrailerInput): TrailerInput {
  return {
    intent: b.intent ?? a.intent,
    risk: b.risk ?? a.risk,
    scope: b.scope?.length ? b.scope : a.scope,
    reviewFocus: b.reviewFocus?.length ? b.reviewFocus : a.reviewFocus,
    closes: b.closes?.length ? b.closes : a.closes,
    agent: b.agent ?? a.agent,
  };
}

/**
 * Append only the MISSING trailers to an existing message (used by `ch push`
 * when amending). Preserves the author's subject/body/trailers and never
 * duplicates a key already present.
 */
export function appendMissingTrailers(message: string, t: TrailerInput): string {
  const present = presentKeys(message);
  const add: string[] = [];
  if (t.intent && !present.has("Intent")) add.push(`Intent: ${t.intent.trim()}`);
  if (!present.has("Risk")) add.push(`Risk: ${t.risk ?? "low"}`);
  const scope = (t.scope ?? []).map(s => s.trim()).filter(Boolean);
  if (scope.length && !present.has("Scope")) add.push(`Scope: ${scope.join(", ")}`);
  if (!present.has("Agent") && t.agent) add.push(`Agent: ${t.agent.trim()}`);
  if (!add.length) return message.endsWith("\n") ? message : message + "\n";
  const trimmed = message.replace(/\s+$/, "");
  // If the message already ends in a trailer block, glue onto it; else add a
  // blank-line separator first.
  const sep = hasTrailers(message) ? "\n" : "\n\n";
  return trimmed + sep + add.join("\n") + "\n";
}
