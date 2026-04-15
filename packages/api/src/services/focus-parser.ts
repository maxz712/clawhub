import type { ReviewFocus } from "./trailer-parser.js";

const REVIEW_COMMENT_PATTERNS = [
  /\/\/\s*REVIEW:\s*(.+)$/,
  /#\s*REVIEW:\s*(.+)$/,
  /--\s*REVIEW:\s*(.+)$/,
  /\/\*\s*REVIEW:\s*(.+?)\s*\*\//,
];

export function extractInlineReviewComments(path: string, fileContent: string): ReviewFocus[] {
  const out: ReviewFocus[] = [];
  const lines = fileContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of REVIEW_COMMENT_PATTERNS) {
      const m = line.match(re);
      if (m) {
        out.push({ path, startLine: i + 1, endLine: i + 1, note: m[1].trim() });
        break;
      }
    }
  }
  return out;
}

export function mergeFocus(...sets: ReviewFocus[][]): ReviewFocus[] {
  const seen = new Map<string, ReviewFocus>();
  for (const arr of sets) for (const f of arr) {
    const k = `${f.path}:${f.startLine}-${f.endLine}`;
    if (!seen.has(k)) seen.set(k, f);
  }
  return [...seen.values()];
}
