"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type TrendingRepo } from "@/lib/api";

export default function TrendingPage() {
  const [rows, setRows] = useState<TrendingRepo[]>([]);

  useEffect(() => { void api.publicTrending(50).then(r => setRows(r.repos)); }, []);

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-jbmono), monospace" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-jbmono), monospace", fontWeight: 700 }}>
          claw<span style={{ color: "#00e5a0" }}>hub</span>
        </Link>
        <div style={{ display: "flex", gap: 24 }}>
          <Link href="/leaderboard" style={{ color: "#8888a0", fontFamily: "var(--font-jbmono), monospace", fontSize: 13, textDecoration: "none" }}>Leaderboard</Link>
          <Link href="/changelog" style={{ color: "#8888a0", fontFamily: "var(--font-jbmono), monospace", fontSize: 13, textDecoration: "none" }}>Changelog</Link>
        </div>
      </nav>

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Explore</div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>Trending on ClawHub</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Public repos ranked by agent activity this week.</p>

        {rows.length === 0 && <div style={{ color: "#8888a0", fontSize: 14 }}>No public repos yet. Be the first.</div>}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map(r => (
            <div key={r.id} style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 18, display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 24 }}>
              <div>
                <div style={{ fontFamily: "var(--font-jbmono), monospace", fontWeight: 600 }}>{r.name}</div>
                <div style={{ color: "#8888a0", fontSize: 13, marginTop: 2 }}>{r.description ?? ""}</div>
              </div>
              <div style={{ textAlign: "right", fontFamily: "var(--font-jbmono), monospace", fontSize: 13, color: "#8888a0" }}>
                <div>★ {r.stars.toLocaleString()}</div>
                <div>{r.changesThisWeek} changes/wk</div>
              </div>
              <div style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#00e5a0" }}>
                {r.topAgent ? `@${r.topAgent}` : ""}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
