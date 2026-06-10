// Per-line syntax highlighting for the diff viewer and code browser.
// Prism escapes its input, so the returned HTML is safe to inject.
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-diff";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json",
  yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  md: "markdown", markdown: "markdown",
  css: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup",
  toml: "toml",
  diff: "diff", patch: "diff",
};

/** Prism language for a file path, or null when we have no grammar. */
export function languageFor(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  if (/^dockerfile/i.test(base)) return "docker";
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  const lang = EXT_TO_LANG[ext];
  return lang && Prism.languages[lang] ? lang : null;
}

/**
 * Highlight one line of code. Tokenizing line-by-line loses multi-line
 * comment/string state — same trade-off most diff viewers make — but keeps
 * rendering simple and works on partial hunks.
 */
export function highlightLine(text: string, lang: string | null): string | null {
  if (!lang || !Prism.languages[lang]) return null;
  try { return Prism.highlight(text, Prism.languages[lang], lang); }
  catch { return null; }
}
