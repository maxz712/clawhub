"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

interface Entry { id: string; title: string; body: string; tag: string | null; publishedAt: string }

export default function ChangelogPage() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void api
      .publicChangelog()
      .then(r => setEntries(r.entries))
      .catch(() => setErr("Couldn't load the changelog — try again"));
  }, []);

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-outfit), sans-serif", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Changelog</div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>What&apos;s new</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Product updates for ClawHub.</p>

        {err && <div style={{ color: "#ff6b6b", fontSize: 14 }}>{err}</div>}
        {!err && entries === null && <div style={{ color: "#8888a0", fontSize: 14 }}>Loading…</div>}
        {!err && entries !== null && entries.length === 0 && <div style={{ color: "#8888a0", fontSize: 14 }}>No entries yet.</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {(entries ?? []).map(e => (
            <article key={e.id} style={{ borderLeft: "2px solid #2a2a33", paddingLeft: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
                {e.tag && <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#00e5a0", background: "rgba(0,229,160,0.15)", padding: "2px 8px", borderRadius: 4 }}>{e.tag}</span>}
                <span style={{ fontFamily: "var(--font-outfit), sans-serif", fontSize: 12, color: "#8888a0" }}>{new Date(e.publishedAt).toLocaleDateString()}</span>
              </div>
              <h2 style={{ fontSize: 24, fontWeight: 700, margin: "4px 0 8px" }}>{e.title}</h2>
              <div style={{ color: "#c0c0d0", whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{e.body}</div>
            </article>
          ))}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
