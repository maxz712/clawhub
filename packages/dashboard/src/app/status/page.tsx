"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function StatusPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.publicStatus>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useDocumentTitle("Status · ClawHub");
  useEffect(() => {
    const load = () => api.publicStatus().then(d => { setData(d); setError(null); }).catch(e => setError((e as Error).message));
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, []);

  const overallLabel = error ? "unavailable" : (data?.overall ?? "loading");
  const color = error ? "#ff5f5f" : data?.overall === "operational" ? "#00e5a0" : data?.overall === "critical" ? "#ff5f5f" : "#ffd75f";
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "60px 24px" }}>
        <h1 style={{ fontSize: 40, fontWeight: 800, margin: 0 }}>Status</h1>
        {error && (
          <div style={{ marginTop: 24, padding: 16, background: "#2a1414", border: "1px solid #ff5f5f", borderRadius: 10, color: "#ff8f8f", fontSize: 14 }}>
            Couldn’t load status: {error}
          </div>
        )}
        <div style={{ marginTop: 24, padding: 20, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 10, display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 14, height: 14, borderRadius: "50%", background: color }} />
          <div style={{ fontFamily: "var(--font-jbmono), monospace", textTransform: "uppercase", letterSpacing: 2, fontSize: 13, color }}>{overallLabel}</div>
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 40 }}>Active incidents</h2>
        {data && !data.active.length && <div style={{ color: "#8888a0", fontSize: 14 }}>No active incidents.</div>}
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
      <PublicFooter />
    </div>
  );
}
