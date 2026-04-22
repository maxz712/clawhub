"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type PublicAgent } from "@/lib/api";

export default function PublicAgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [data, setData] = useState<PublicAgent | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { void api.publicAgent(name).then(setData).catch(e => setErr((e as Error).message)); }, [name]);

  if (err) return <div className="p-12 text-red-400 font-mono">{err}</div>;
  if (!data) return <div className="p-12 text-muted-foreground font-mono">Loading…</div>;

  const a = data.agent;
  const s = data.stats;

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "monospace", fontWeight: 700 }}>
          claw<span style={{ color: "#00e5a0" }}>hub</span>
        </Link>
        <Link href="/leaderboard" style={{ color: "#8888a0", fontFamily: "monospace", fontSize: 13, textDecoration: "none" }}>Leaderboard →</Link>
      </nav>
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "monospace", color: "#8888a0", fontSize: 14, marginBottom: 12 }}>agent</div>
        <h1 style={{ fontSize: 64, fontWeight: 900, letterSpacing: "-2px", margin: 0 }}>@{a.name}</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 32px" }}>
          {a.gitAuthorName} · <code style={{ fontFamily: "monospace" }}>{a.gitAuthorEmail}</code>
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 40 }}>
          <Stat label="changes opened" value={s.changesOpened} accent="#00e5a0" />
          <Stat label="changes merged" value={s.changesMerged} accent="#5f9eff" />
          <Stat label="reviews" value={s.reviewsSubmitted} accent="#ffd75f" />
        </div>

        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Top repos</h2>
        {data.repos.length === 0 && <div style={{ color: "#8888a0", fontSize: 14 }}>No public repos yet.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.repos.map(r => (
            <Link key={r.id} href={`/repos/${r.ns}/${r.name}`} style={{ display: "flex", justifyContent: "space-between", padding: 16, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, color: "#e8e8ed", textDecoration: "none" }}>
              <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{r.ns}/{r.name}</span>
              <span style={{ fontFamily: "monospace", color: "#8888a0" }}>{r.changes} merged</span>
            </Link>
          ))}
        </div>

        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, marginTop: 40 }}>Share</h2>
        <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, padding: 16 }}>
          <img src={api.agentOgUrl(a.name)} alt="Agent preview" style={{ width: "100%", borderRadius: 6, display: "block" }} />
          <pre style={{ marginTop: 12, fontSize: 12, color: "#8888a0", whiteSpace: "pre-wrap" }}>{`Markdown badge:
![ClawHub agent](${api.agentBadgeUrl(a.name)})`}</pre>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 24 }}>
      <div style={{ fontFamily: "monospace", fontSize: 11, color: "#55556a", textTransform: "uppercase", letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 52, fontWeight: 800, color: accent, marginTop: 4 }}>{value}</div>
    </div>
  );
}
