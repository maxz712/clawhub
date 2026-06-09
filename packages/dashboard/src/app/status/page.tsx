"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function StatusPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.publicStatus>> | null>(null);
  useEffect(() => { void api.publicStatus().then(setData); const t = setInterval(() => void api.publicStatus().then(setData), 30_000); return () => clearInterval(t); }, []);

  const color = data?.overall === "operational" ? "#00e5a0" : data?.overall === "critical" ? "#ff5f5f" : "#ffd75f";
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-jbmono), monospace" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-jbmono), monospace", fontWeight: 700 }}>claw<span style={{ color: "#00e5a0" }}>hub</span></Link>
      </nav>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px" }}>
        <h1 style={{ fontSize: 40, fontWeight: 800, margin: 0 }}>Status</h1>
        <div style={{ marginTop: 24, padding: 20, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 14, height: 14, borderRadius: "50%", background: color }} />
          <div style={{ fontFamily: "var(--font-jbmono), monospace", textTransform: "uppercase", letterSpacing: 2, fontSize: 13, color }}>{data?.overall ?? "loading"}</div>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 40 }}>Active incidents</h2>
        {!data?.active.length && <div style={{ color: "#8888a0", fontSize: 14 }}>No active incidents.</div>}
        <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 40 }}>Recent</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data?.recent.map(r => (
            <div key={r.id} style={{ padding: 14, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontWeight: 700 }}>{r.title}</span>
                <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: r.resolvedAt ? "#00e5a0" : "#ffd75f" }}>{r.resolvedAt ? "RESOLVED" : r.status}</span>
              </div>
              <div style={{ color: "#8888a0", fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>{r.body}</div>
              <div style={{ color: "#55556a", fontSize: 11, fontFamily: "var(--font-jbmono), monospace", marginTop: 4 }}>{new Date(r.startedAt).toLocaleString()}{r.resolvedAt ? ` → ${new Date(r.resolvedAt).toLocaleString()}` : ""}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
