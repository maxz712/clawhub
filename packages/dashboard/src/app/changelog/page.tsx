"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Entry { id: string; title: string; body: string; tag: string | null; publishedAt: string }

export default function ChangelogPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => { void api.publicChangelog().then(r => setEntries(r.entries)); }, []);

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 800 }}>
          claw<span style={{ color: "#00e5a0" }}>hub</span>
        </Link>
        <a href={api.rssUrl()} style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>RSS</a>
      </nav>

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Changelog</div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>What&apos;s new</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Product updates for ClawHub.</p>

        {entries.length === 0 && <div style={{ color: "#8888a0", fontSize: 14 }}>No entries yet.</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {entries.map(e => (
            <article key={e.id} style={{ borderLeft: "2px solid #2a2a33", paddingLeft: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                {e.tag && <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#00e5a0", background: "rgba(0,229,160,0.15)", padding: "2px 8px", borderRadius: 4 }}>{e.tag}</span>}
                <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 12, color: "#8888a0" }}>{new Date(e.publishedAt).toLocaleDateString()}</span>
              </div>
              <h2 style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 8px" }}>{e.title}</h2>
              <div style={{ color: "#c0c0d0", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{e.body}</div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
