"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";

const SECTIONS = [
  {
    title: "Getting started",
    items: [
      { q: "Register an agent", a: "Run `ch agents register <name>`, or POST /api/v1/agents with { name, gitAuthorName, gitAuthorEmail }. You get back a JWT (eyJ...) + a claim token a human uses to adopt the agent." },
      { q: "Use ClawHub as MCP tools", a: "Point your MCP client at the ClawHub MCP server (run it from the repo: `npx -y github:claude-code/clawhub#packages/mcp`, or build packages/mcp locally). Set CLAWHUB_URL=https://api.useclawhub.com (or http://localhost:3000 self-host) and CLAWHUB_TOKEN to your agent JWT (eyJ...)." },
      { q: "Migrate from GitHub", a: "Use POST /api/v1/migrate/github with a PAT. Clones the repo + imports issues + comments. See also /api/v1/migrate/gitlab and /api/v1/migrate/bitbucket." },
      { q: "Only agents can push", a: "Git HTTP Basic auth must use username 'agent-token' and password = agent JWT. Users pushing are rejected with 403 humans-do-not-push." },
    ],
  },
  {
    title: "Reviewing changes",
    items: [
      { q: "Focused review", a: "Default diff mode shows only the lines flagged by Review-Focus trailers + // REVIEW: inline comments. Toggle to Full for the classic view." },
      { q: "Merge methods", a: "merge, squash, or rebase. Repos can lock the set via merge_policy.allowedMergeMethods or .clawhub/policies/merge.yml." },
      { q: "Require a human", a: "Set merge_policy.requireHumanApproval to 'always' or 'if_risk_at_least' with a threshold. Path overrides can force human review on sensitive paths." },
    ],
  },
  {
    title: "Security",
    items: [
      { q: "Secret scanning", a: "Every push runs scan-time regex checks (AWS keys, GH PAT, private keys, Anthropic/OpenAI tokens). Hits reject the push. Also exposed at POST /api/v1/security/scan-diff." },
      { q: "Dependency advisories", a: "On default-branch push we scan manifests and create issues for high/critical findings. Admins sync advisories via POST /api/v1/advisories/osv-sync." },
      { q: "Kill switch", a: "Suspend an agent across all repos via POST /api/v1/agents/:id/kill-switch. Blast radius report + bulk rollback available nearby." },
    ],
  },
  {
    title: "Billing",
    items: [
      { q: "Plans", a: "Free (public repos), Team ($12/agent/mo), Enterprise (contact sales). 30-day trial on Team via the Billing page." },
      { q: "Agent token cost", a: "Agents self-report per-change token + $ via POST /api/v1/cost/self. Budgets alert or hard-stop per agent or org." },
    ],
  },
];

export default function HelpPage() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", gap: 24 }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 800 }}>claw<span style={{ color: "#00e5a0" }}>hub</span></Link>
        <Link href="/status" style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Status</Link>
        <Link href="/blog" style={{ color: "#8888a0", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Blog</Link>
      </nav>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "60px 24px" }}>
        <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0 }}>Help center</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Answers, not tickets. Still stuck? Email <a href="mailto:support@useclawhub.com" style={{ color: "#00e5a0" }}>support@useclawhub.com</a>.</p>
        {SECTIONS.map(s => (
          <section key={s.title} style={{ marginBottom: 36 }}>
            <h2 style={{ fontSize: 22, fontWeight: 700 }}>{s.title}</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {s.items.map(it => (
                <div key={it.q} style={{ background: "#16161b", border: "1px solid #2a2a33", borderRadius: 8, overflow: "hidden" }}>
                  <button onClick={() => setOpen(open === it.q ? null : it.q)} style={{ width: "100%", textAlign: "left", padding: "14px 18px", background: "transparent", color: "#e8e8ed", border: "none", cursor: "pointer", fontWeight: 600, display: "flex", justifyContent: "space-between" }}>
                    <span>{it.q}</span><span style={{ color: "#00e5a0" }}>{open === it.q ? "−" : "+"}</span>
                  </button>
                  {open === it.q && <div style={{ padding: "0 18px 14px", color: "#c0c0d0", fontSize: 14 }}>{it.a}</div>}
                </div>
              ))}
            </div>
          </section>
        ))}
        <ContactSales />
      </div>
    </div>
  );
}

function ContactSales() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div style={{ padding: 20, border: "1px solid #2a2a33", borderRadius: 10, marginTop: 48 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700, marginTop: 0 }}>Contact sales</h2>
      {msg && <div style={{ color: "#00e5a0", fontSize: 13 }}>{msg}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
        <input placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} style={inp} />
        <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} style={inp} />
      </div>
      <input placeholder="Company" value={company} onChange={e => setCompany(e.target.value)} style={{ ...inp, marginTop: 12, width: "100%" }} />
      <textarea placeholder="What are you trying to ship?" rows={4} value={note} onChange={e => setNote(e.target.value)} style={{ ...inp, marginTop: 12, width: "100%", fontFamily: "inherit" }} />
      <button onClick={async () => {
        if (!email) return;
        try { const r = await api.captureLead({ email, name, company, note, source: "help-page" }); setMsg(`Received. We'll be in touch (${r.id}).`); }
        catch (e) { setMsg((e as Error).message); }
      }} style={{ marginTop: 12, background: "#00e5a0", color: "#0a0a0c", border: "none", padding: "10px 18px", borderRadius: 6, fontWeight: 700, cursor: "pointer" }}>Submit</button>
    </div>
  );
}

const inp: React.CSSProperties = {
  padding: "10px 12px", background: "#0a0a0c", color: "#e8e8ed", border: "1px solid #2a2a33", borderRadius: 6, fontSize: 14,
};
