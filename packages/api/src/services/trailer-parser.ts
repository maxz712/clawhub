export type Risk = "low" | "medium" | "high" | "critical";

export interface ReviewFocus {
  path: string;
  startLine: number;
  endLine: number;
  note?: string;
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

export function parseFocusLine(line: string): ReviewFocus[] {
  // Format: "path:start-end — note" or "path:start-end" or "path:line"
  const m = line.match(/^([^\s:]+):(\d+)(?:-(\d+))?\s*(?:[—-]\s*(.+))?$/);
  if (!m) return [];
  const startLine = Number(m[2]);
  const endLine = m[3] ? Number(m[3]) : startLine;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return [];
  return [{ path: m[1], startLine, endLine, note: m[4]?.trim() }];
}
