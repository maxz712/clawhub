import type { GitService } from "./git.js";

// Tiny, safe Markdown renderer. Not the fanciest — renders headings, paragraphs,
// lists, code blocks, inline code, links, bold/italic. Escapes HTML.
// For richer rendering the dashboard can render-side, this is the API surface.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderMarkdown(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf: string[] = [];
  let listMode: "ul" | "ol" | null = null;

  function closeList() { if (listMode) { out.push(`</${listMode}>`); listMode = null; } }
  function openList(kind: "ul" | "ol") { if (listMode !== kind) { closeList(); out.push(`<${kind}>`); listMode = kind; } }

  for (const line of lines) {
    if (inCode) {
      if (line.startsWith("```")) {
        out.push(`<pre><code class="lang-${esc(codeLang)}">${esc(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = []; inCode = false; codeLang = "";
      } else { codeBuf.push(line); }
      continue;
    }
    if (line.startsWith("```")) { inCode = true; codeLang = line.slice(3).trim(); closeList(); continue; }
    if (/^#{1,6}\s/.test(line)) {
      closeList();
      const n = line.match(/^#+/)![0].length;
      out.push(`<h${n}>${inline(line.replace(/^#+\s*/, ""))}</h${n}>`);
      continue;
    }
    if (/^\s*[-*+]\s/.test(line)) { openList("ul"); out.push(`<li>${inline(line.replace(/^\s*[-*+]\s+/, ""))}</li>`); continue; }
    if (/^\s*\d+\.\s/.test(line)) { openList("ol"); out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`); continue; }
    if (line.trim() === "") { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  return out.join("\n");
}

function inline(s: string): string {
  let t = esc(s);
  // Inline code.
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold.
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic.
  t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Links.
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => `<a href="${escAttr(href)}">${txt}</a>`);
  return t;
}

function escAttr(s: string): string {
  // Only allow http/https/mailto/relative.
  const trimmed = s.trim();
  if (!/^(https?:|mailto:|\/|#|\.)/i.test(trimmed)) return "#";
  return trimmed.replace(/"/g, "&quot;");
}

export async function renderRepoDoc(git: GitService, ns: string, repoName: string, commit: string, relPath: string): Promise<{ html: string; source: string } | null> {
  const normalized = relPath.replace(/^\/+/, "");
  if (normalized.includes("..")) return null;
  const content = await git.fileAt(ns, repoName, commit, normalized);
  if (!content) return null;
  return { html: renderMarkdown(content), source: content };
}
