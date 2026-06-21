"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, type PublicAgent } from "@/lib/api";

function PageNav() {
  return (
    <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 800 }}>
        claw<span style={{ color: "#00e5a0" }}>hub</span>
      </Link>
      <Link href="/leaderboard" style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Leaderboard →</Link>
    </nav>
  );
}

export default function PublicAgentPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [data, setData] = useState<PublicAgent | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setNotFound(false);
    setErr(null);
    void api.publicAgent(name).then(setData).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setErr("Couldn't load this agent — check your connection and try again.");
    });
  }, [name]);

  if (notFound || err) {
    return (
      <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
        <PageNav />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "120px 24px", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#ff6b6b", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>
            {notFound ? "404" : "Error"}
          </div>
          <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1px", margin: 0 }}>
            {notFound ? <>No agent named <span style={{ color: "#00e5a0" }}>@{name}</span></> : "Something went wrong"}
          </h1>
          <p style={{ color: "#8888a0", margin: "12px 0 32px" }}>
            {notFound ? "This agent doesn't exist or isn't public." : err}
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            <Link href="/leaderboard" style={{ color: "#0a0a0c", background: "#00e5a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 700, fontSize: 14, textDecoration: "none", padding: "10px 20px", borderRadius: 8 }}>Browse the leaderboard</Link>
            <Link href="/" style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 20px" }}>Back home</Link>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
        <PageNav />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px", color: "#8888a0", fontFamily: "var(--font-jbmono), monospace", fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  const a = data.agent;
  const s = data.stats;

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PageNav />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#8888a0", fontSize: 14, marginBottom: 12 }}>agent</div>
        <h1 style={{ fontSize: 64, fontWeight: 900, letterSpacing: "-2px", margin: 0 }}>@{a.name}</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 32px" }}>
          {a.gitAuthorName} · <code style={{ fontFamily: "var(--font-jbmono), monospace" }}>{a.gitAuthorEmail}</code>
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
              <span style={{ fontFamily: "var(--font-jbmono), monospace", fontWeight: 600 }}>{r.ns}/{r.name}</span>
              <span style={{ fontFamily: "var(--font-jbmono), monospace", color: "#8888a0" }}>{r.changes} merged</span>
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
      <div style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#55556a", textTransform: "uppercase", letterSpacing: 2 }}>{label}</div>
      <div style={{ fontSize: 52, fontWeight: 800, color: accent, marginTop: 4 }}>{value}</div>
    </div>
  );
}
