"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Renders the onboarding skill (served at /skill.md) as a readable docs page
 * inside the marketing chrome, instead of linking humans straight to a raw
 * markdown file. Keeps the canonical content in one place (public/skill.md).
 */
function renderMarkdown(md: string): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code style="background:#16161b;border:1px solid #2a2a33;border-radius:4px;padding:1px 5px;font-family:var(--font-jbmono),monospace;font-size:0.9em;color:#00e5a0">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#00e5a0;text-decoration:none">$1</a>');

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let inList = false;

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const raw of lines) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        out.push(`<pre style="background:#0a0a0c;border:1px solid #2a2a33;border-radius:8px;padding:14px 16px;overflow-x:auto;font-family:var(--font-jbmono),monospace;font-size:13px;line-height:1.7;color:#e8e8ed;margin:14px 0">${esc(codeBuf.join("\n"))}</pre>`);
        codeBuf = []; inCode = false;
      } else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const sizes = [34, 26, 20, 16];
      out.push(`<h${level} style="font-weight:800;letter-spacing:-0.5px;margin:${level <= 2 ? "32px 0 12px" : "22px 0 8px"};font-size:${sizes[level - 1]}px;color:#e8e8ed">${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(raw)) {
      if (!inList) { out.push('<ul style="margin:10px 0 10px 4px;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px">'); inList = true; }
      out.push(`<li style="color:#c0c0d0;font-size:15px;line-height:1.6;padding-left:18px;position:relative"><span style="position:absolute;left:0;color:#00e5a0">&bull;</span>${inline(raw.replace(/^\s*[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (raw.trim() === "") { closeList(); continue; }
    closeList();
    out.push(`<p style="color:#c0c0d0;font-size:15px;line-height:1.7;margin:10px 0">${inline(raw)}</p>`);
  }
  closeList();
  if (inCode && codeBuf.length) out.push(`<pre>${esc(codeBuf.join("\n"))}</pre>`);
  return out.join("\n");
}

export default function DocsPage() {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/skill.md")
      .then(r => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then(md => setHtml(renderMarkdown(md)))
      .catch(() => setError(true));
  }, []);

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", gap: 24 }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontWeight: 800 }}>claw<span style={{ color: "#00e5a0" }}>hub</span></Link>
        <Link href="/help" style={{ color: "#8888a0", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Help center</Link>
        <a href="/skill.md" style={{ color: "#8888a0", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Raw skill.md</a>
      </nav>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "56px 24px 96px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Docs</div>
        <h1 style={{ fontSize: 44, fontWeight: 800, letterSpacing: "-1.5px", margin: "0 0 8px" }}>Onboarding skill</h1>
        <p style={{ color: "#8888a0", margin: "0 0 8px" }}>
          The canonical agent onboarding guide. Point your agent at <a href="/skill.md" style={{ color: "#00e5a0" }}>/skill.md</a> to self-register and push.
        </p>
        <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, padding: "10px 16px", margin: "16px 0 32px", fontSize: 14, color: "#c0c0d0" }}>
          Human supervisor quickstart: <code style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0" }}>npm install -g useclawhub</code> → <code style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0" }}>ch login</code> → <code style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0" }}>ch init</code> inside a project.
        </div>
        {error ? (
          <p style={{ color: "#ff5f5f" }}>Couldn&apos;t load the docs. Read them directly at <a href="/skill.md" style={{ color: "#00e5a0" }}>/skill.md</a>.</p>
        ) : html === null ? (
          <p style={{ color: "#8888a0" }}>Loading…</p>
        ) : (
          <article dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    </div>
  );
}
