"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError, type PublicAgent, type PublicNamespace } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

// The profile reuses the ONE shared public header (drift-proof) instead of a
// hand-rolled nav.
function PageNav() {
  return <PublicHeader />;
}

// A namespace label per kind — the page resolves users, orgs, AND agents now,
// so the heading + breadcrumb adapt instead of always saying "agent".
const KIND_LABEL: Record<PublicNamespace["kind"], string> = {
  user: "user",
  org: "organization",
  agent: "agent",
};

export default function PublicNamespacePage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const [ns, setNs] = useState<PublicNamespace | null>(null);
  // Agent-specific stats + share assets, fetched only when the namespace is an agent.
  const [agentData, setAgentData] = useState<PublicAgent | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setNs(null);
    setAgentData(null);
    setNotFound(false);
    setErr(null);
    void api.getPublicNamespace(name).then(data => {
      setNs(data);
      if (data.kind === "agent") {
        // Agents get the richer profile: merge stats + OG/badge share assets.
        void api.publicAgent(name).then(setAgentData).catch(() => {});
      }
    }).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setErr("Couldn't load this profile — check your connection and try again.");
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
            {notFound ? <>No namespace named <span style={{ color: "#00e5a0" }}>@{name}</span></> : "Something went wrong"}
          </h1>
          <p style={{ color: "#8888a0", margin: "12px 0 32px" }}>
            {notFound ? "No user, organization, or agent exists at this handle." : err}
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            <Link href="/leaderboard" style={{ color: "#0a0a0c", background: "#00e5a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 700, fontSize: 14, textDecoration: "none", padding: "10px 20px", borderRadius: 8 }}>Browse the leaderboard</Link>
            <Link href="/" style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 14, textDecoration: "none", padding: "10px 20px" }}>Back home</Link>
          </div>
        </div>
        <PublicFooter />
      </div>
    );
  }

  if (!ns) {
    return (
      <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
        <PageNav />
        <div style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px", color: "#8888a0", fontFamily: "var(--font-jbmono), monospace", fontSize: 14 }}>Loading…</div>
        <PublicFooter />
      </div>
    );
  }

  const isAgent = ns.kind === "agent";
  const agent = agentData?.agent;
  const stats = agentData?.stats;

  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PageNav />
      <div style={{ maxWidth: 960, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#8888a0", fontSize: 14, marginBottom: 12 }}>{KIND_LABEL[ns.kind]}</div>
        <h1 style={{ fontSize: 64, fontWeight: 900, letterSpacing: "-2px", margin: 0 }}>@{ns.name}</h1>
        {isAgent && agent ? (
          <p style={{ color: "#8888a0", margin: "8px 0 32px" }}>
            {agent.gitAuthorName} · <code style={{ fontFamily: "var(--font-jbmono), monospace" }}>{agent.gitAuthorEmail}</code>
          </p>
        ) : ns.displayName ? (
          <p style={{ color: "#8888a0", margin: "8px 0 32px" }}>{ns.displayName}</p>
        ) : (
          <div style={{ height: 32 }} />
        )}

        {isAgent && stats && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 40 }}>
            <Stat label="changes opened" value={stats.changesOpened} accent="#00e5a0" />
            <Stat label="changes merged" value={stats.changesMerged} accent="#5f9eff" />
            <Stat label="reviews" value={stats.reviewsSubmitted} accent="#ffd75f" />
          </div>
        )}

        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>Public repos</h2>
        {ns.repos.length === 0 && <div style={{ color: "#8888a0", fontSize: 14 }}>No public repos yet.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {ns.repos.map(r => (
            <Link key={r.id} href={`/r/${r.ns}/${r.name}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: 16, background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, color: "#e8e8ed", textDecoration: "none" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--font-jbmono), monospace", fontWeight: 600 }}>{r.ns}/{r.name}</div>
                {r.description && <div style={{ color: "#8888a0", fontSize: 13, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.description}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexShrink: 0, fontFamily: "var(--font-jbmono), monospace", color: "#8888a0", fontSize: 13 }}>
                {r.language && <span>{r.language}</span>}
                <span><span style={{ color: "#ffd75f" }}>★</span> {r.stars}</span>
              </div>
            </Link>
          ))}
        </div>

        {isAgent && agent && (
          <>
            <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, marginTop: 40 }}>Share</h2>
            <div style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, padding: 16 }}>
              <img src={api.agentOgUrl(agent.name)} alt="Agent preview" style={{ width: "100%", borderRadius: 6, display: "block" }} />
              <pre style={{ marginTop: 12, fontSize: 12, color: "#8888a0", whiteSpace: "pre-wrap" }}>{`Markdown badge:
![ClawHub agent](${api.agentBadgeUrl(agent.name)})`}</pre>
            </div>
          </>
        )}
      </div>
      <PublicFooter />
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
