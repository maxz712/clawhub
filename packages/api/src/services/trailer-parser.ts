export type Risk = "low" | "medium" | "high" | "critical";

export interface ReviewFocus {
  path: string;
  startLine: number;
  endLine: number;
  note?: string;
  // Where this focus came from, when the diff surface merges the three sources
  // (M1 "wire the dead pipe"). Absent on trailer/inline focus parsed here (it's
  // author focus by construction); stamped by the diff route when it unions the
  // author flags, the derived Review Brief, and reviewer additionalFocus.
  source?: "author" | "derived" | "reviewer";
}

export interface ParsedTrailers {
  intent?: string;
  risk?: Risk;
  scope: string[];
  reviewFocus: ReviewFocus[];
  closes: number[];
  agent?: string;
  // `Draft: true` marks the Change work-in-progress so reviewers skip it until it
  // is published (`Draft: false` / no trailer / the publish API). undefined = the
  // trailer was absent (don't change the existing draft state).
  draft?: boolean;
  raw: Record<string, string[]>;
}

const RISK_SET = new Set<Risk>(["low", "medium", "high", "critical"]);

export function parseTrailers(commitMessage: string): ParsedTrailers {
  const lines = commitMessage.split(/\r?\n/);
  const subject = (lines[0] ?? "").trim();
  const raw: Record<string, string[]> = {};

  for (const line of lines) {
    const m = line.match(/^([A-Z][A-Za-z-]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    (raw[key] ??= []).push(value);
  }

  const risk = raw["Risk"]?.[0]?.toLowerCase() as Risk | undefined;
  const scope = (raw["Scope"] ?? [])
    .flatMap(v => v.split(","))
    .map(s => s.trim())
    .filter(Boolean);

  const reviewFocus: ReviewFocus[] = (raw["Review-Focus"] ?? []).flatMap(parseFocusLine);
  const closes = (raw["Closes"] ?? [])
    .flatMap(v => v.split(/[\s,]+/))
    .map(s => s.trim().replace(/^#/, ""))
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);

  const draftRaw = raw["Draft"]?.[0]?.trim().toLowerCase();
  const draft = draftRaw === undefined
    ? undefined
    : draftRaw === "true" || draftRaw === "yes" || draftRaw === "1" || draftRaw === "wip";

  return {
    intent: raw["Intent"]?.[0] ?? subject ?? undefined,
    risk: risk && RISK_SET.has(risk) ? risk : undefined,
    scope,
    reviewFocus,
    closes,
    agent: raw["Agent"]?.[0],
    draft,
    raw,
  };
}

const TRAILER_LINE = /^([A-Z][A-Za-z-]+):\s*(.+)$/;

/**
 * Strip the trailing trailer block from ONE commit message body and return the
 * prose that remains (subject line dropped). Git defines the trailer block as
 * the last paragraph when it's (mostly) `Key: value` lines — so we only remove
 * lines that look like trailers from the END, stopping at the first prose line.
 * A body line that merely resembles a trailer (e.g. "Note: see above") in the
 * middle of the description is preserved.
 */
export function stripTrailerBlock(message: string): string {
  const lines = message.split(/\r?\n/);
  // Drop the subject (line 0) — `intent` already captures it.
  const body = lines.slice(1);
  // Trim trailing blank lines.
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  // Remove the contiguous trailer block at the tail (trailer lines + blanks
  // between them), stopping at the first non-trailer prose line.
  let end = body.length;
  while (end > 0) {
    const line = body[end - 1];
    if (line.trim() === "" || TRAILER_LINE.test(line)) { end--; continue; }
    break;
  }
  // Only strip the tail if it actually contained at least one trailer — a plain
  // paragraph of blank-trimmed prose stays whole.
  const tail = body.slice(end);
  const kept = tail.some(l => TRAILER_LINE.test(l)) ? body.slice(0, end) : body;
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();
  while (kept.length && kept[0].trim() === "") kept.shift();
  return kept.join("\n").trim();
}

/**
 * Build the Change `description` from the aggregated commit messages: each
 * commit's body with its trailer block stripped, non-empty ones joined, capped
 * at 8KB. Newest-first (git-log order). Returns null when there's no prose.
 */
export function describeCommits(commits: Array<{ message: string }>, cap = 8192): string | null {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const c of commits) {
    const d = stripTrailerBlock(c.message ?? "");
    if (!d || seen.has(d)) continue;
    seen.add(d);
    parts.push(d);
  }
  if (!parts.length) return null;
  const joined = parts.join("\n\n");
  return joined.length > cap ? joined.slice(0, cap - 1) + "…" : joined;
}

export function parseFocusLine(line: string): ReviewFocus[] {
  // Format: "path:start-end — note" or "path:start-end" or "path:line"
  const m = line.match(/^([^\s:]+):(\d+)(?:-(\d+))?\s*(?:[—-]\s*(.+))?$/);
  if (!m) return [];
  const startLine = Number(m[2]);
  const endLine = m[3] ? Number(m[3]) : startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return [];
  return [{ path: m[1], startLine, endLine, note: m[4]?.trim() }];
}
