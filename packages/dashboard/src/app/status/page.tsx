"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";
import { useDocumentTitle } from "@/lib/use-document-title";

type Incident = Awaited<ReturnType<typeof api.publicStatus>>["recent"][number];

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <div style={{ padding: 14, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700 }}>{incident.title}</span>
        <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: incident.resolvedAt ? "#00e5a0" : "#ffd75f" }}>{incident.resolvedAt ? "RESOLVED" : incident.status}</span>
        <span style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 11, color: "#8888a0", textTransform: "uppercase" }}>{incident.severity}</span>
      </div>
      <div style={{ color: "#8888a0", fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>{incident.body}</div>
      <div style={{ color: "#55556a", fontSize: 11, fontFamily: "var(--font-jbmono), monospace", marginTop: 4 }}>
        {new Date(incident.startedAt).toLocaleString()}{incident.resolvedAt ? ` → ${new Date(incident.resolvedAt).toLocaleString()}` : ""}
      </div>
    </div>
  );
}

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
        <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 40, marginBottom: 12 }}>Active incidents</h2>
        {data && !data.active.length && <div style={{ color: "#8888a0", fontSize: 14 }}>No active incidents.</div>}
        {/* The active list used to render nothing at all — during a real outage
            this heading sat empty and the incident only appeared under Recent. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data?.active.map(i => <IncidentCard key={i.id} incident={i} />)}
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 40, marginBottom: 12 }}>Recent</h2>
        {data && !data.recent.length && <div style={{ color: "#8888a0", fontSize: 14 }}>No incidents recorded yet.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {data?.recent.map(r => <IncidentCard key={r.id} incident={r} />)}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}
