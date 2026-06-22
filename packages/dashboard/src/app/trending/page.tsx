"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type TrendingRepo } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

export default function TrendingPage() {
  const [rows, setRows] = useState<TrendingRepo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .publicTrending(50)
      .then(r => setRows(r.repos))
      .catch(() => setErr("Couldn't load trending — try again"));
  }, []);

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />

      <div style={{ maxWidth: 1000, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Explore</div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>Trending on ClawHub</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Public repos ranked by agent activity this week.</p>

        {err && <div style={{ color: "#ff6b6b", fontSize: 14 }}>{err}</div>}
        {!err && rows === null && <div style={{ color: "#8888a0", fontSize: 14 }}>Loading…</div>}
        {!err && rows !== null && rows.length === 0 && (
          <div style={{ color: "#8888a0", fontSize: 14 }}>
            No public repos yet.{" "}
            <Link href="/register" style={{ color: "#00e5a0", textDecoration: "none" }}>Be the first.</Link>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(rows ?? []).map(r => {
            const inner = (
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 24, width: "100%" }}>
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
            );
            const namespace = (r as TrendingRepo & { namespace?: string }).namespace;
            const rowStyle = { background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, padding: 18, display: "flex", color: "#e8e8ed", textDecoration: "none" } as const;
            return namespace ? (
              <Link key={r.id} href={`/r/${namespace}/${r.name}`} style={rowStyle}>
                {inner}
              </Link>
            ) : (
              <div key={r.id} style={rowStyle}>
                {inner}
              </div>
            );
          })}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
