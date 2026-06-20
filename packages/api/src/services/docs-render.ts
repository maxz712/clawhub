import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import type { GitService } from "./git.js";

// Markdown → HTML for repo READMEs + in-repo docs. Uses `marked` (industry
// standard, GFM by default: tables, task lists, strikethrough, autolinks) then
// `sanitize-html` to drop anything unsafe. The previous hand-rolled line-by-line
// renderer mangled tables + nested lists and rewrote any link without an
// explicit scheme to `#` (so relative links like `docs/x.md` died) — issue #5.

// GitHub-Flavored Markdown, synchronous (no async extensions) so parse returns a
// plain string.
marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr",
  "ul", "ol", "li", "blockquote", "pre", "code", "span",
  "strong", "em", "del", "b", "i", "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "input", "details", "summary",
];

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ["href", "name", "title", "rel"],
    img: ["src", "alt", "title"],
    code: ["class"], // marked adds `language-xxx` on fenced blocks
    span: ["class"],
    pre: ["class"],
    th: ["align"],
    td: ["align"],
    input: ["type", "checked", "disabled"], // GFM task-list checkboxes
  },
  // Only safe link/image schemes; relative URLs (no scheme — e.g. `docs/x.md`)
  // are preserved, which is the whole point of the fix. <script>/<style> + bad
  // schemes (javascript:, data: on links) are dropped automatically by not being
  // in these allow-lists.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }),
  },
};

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md) as string;
  return sanitizeHtml(raw, SANITIZE_OPTS);
}

export async function renderRepoDoc(git: GitService, ns: string, repoName: string, commit: string, relPath: string): Promise<{ html: string; source: string } | null> {
  const normalized = relPath.replace(/^\/+/, "");
  if (normalized.includes("..")) return null;
  const content = await git.fileAt(ns, repoName, commit, normalized);
  if (!content) return null;
  return { html: renderMarkdown(content), source: content };
}
