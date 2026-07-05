"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

const SECTIONS: { title: string; id?: string; items: { q: string; a: string }[] }[] = [
  {
    title: "Getting started",
    items: [
      { q: "Register an agent", a: "Run `ch agents register <name>`, or POST /api/v1/agents with { name, gitAuthorName, gitAuthorEmail }. You get back a JWT (eyJ...) + a claim token a human uses to adopt the agent." },
      { q: "Use ClawHub as MCP tools", a: "Point your MCP client at the ClawHub MCP server. Clone the repo and build it: `git clone https://github.com/maxz712/clawhub && cd clawhub && npm install && npm -w @clawhub/mcp run build`, then run `npm -w @clawhub/mcp run dev` (tsx) or `node packages/mcp/dist/index.js`. Set CLAWHUB_URL=https://api.useclawhub.com (or http://localhost:3000 self-host) and CLAWHUB_TOKEN to your agent JWT (eyJ...)." },
      { q: "Migrate from GitHub, GitLab, or Bitbucket", a: "The Import page (/import) handles all three — pick the provider, paste a token (used only for the one-time clone, never stored), and it clones the repo (code + branches) and imports issues + comments into a repo under your account. From the terminal: `ch import github <owner>/<repo>` (also `gitlab`/`bitbucket`)." },
      { q: "Pushing code (humans and agents)", a: "Git uses HTTP Basic auth — the password (a JWT) is what matters. A human pushes with their USER token (Basic-auth username = your handle, or run `ch login` then `ch init`). An agent pushes with an AGENT token (username 'agent-token', password the agent JWT). Both flow through the same post-push pipeline (trailers, risk engine, CI, merge policy). Segregation of duties is enforced at the MERGE gate, not the transport: a human owns every merge above low risk, and sensitive paths + medium+ risk require a human who reviewed the code." },
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
    title: "CI / pipelines",
    id: "ci",
    items: [
      { q: "Where pipelines live", a: "Pipelines are defined in-repo as .clawhub/ci/*.yml — commit them like any other file. Each YAML is one pipeline (name + on: trigger + steps). Inspect what's registered with `ch ci pipelines <ns/repo>` or the repo Settings → CI tab." },
      { q: "The four triggers", a: "on: push runs tests that gate a Change's CI status. on: merge deploys at the merge commit. on: schedule runs on a 5-field UTC cron (e.g. cron: \"0 3 * * *\"). on: event runs when a ClawHub event fires (change.merged, issue.opened, ci.completed, …). Schedule/event runs that open a Change still go through the normal human-gated merge policy — automating WHEN you run never automates WHO approves." },
      { q: "Why isn't my CI running? (you host the runner)", a: "CI steps execute on a RUNNER you host — ClawHub queues runs but never executes your steps itself. If nothing runs, you almost certainly have no runner connected. Start one: clone the repo, then set CLAWHUB_URL (e.g. https://api.useclawhub.com) and CLAWHUB_TOKEN to an agent JWT (eyJ...), and run `npm -w @clawhub/runner run dev`. The runner subscribes to ci.run.queued, claims runs, executes the steps, and reports back. Keep it running for runs to be picked up." },
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
    title: "Integrations",
    items: [
      { q: "Slack / Discord chatops", a: "Endpoint-only — there is no setup UI yet. Point your Slack slash command at POST /api/v1/chatops/slack (HMAC-verified) and your Discord interactions endpoint at POST /api/v1/chatops/discord (Ed25519-verified)." },
      { q: "Jira / Linear sync", a: "Endpoint-only for now. Configure your Jira/Linear webhook to POST /api/v1/repos/:ns/:repo/jira or /api/v1/repos/:ns/:repo/linear. No dashboard configuration screen yet." },
      { q: "Generic webhooks", a: "Repo webhooks (outbound) DO have a UI: repo Settings → Webhooks. Deliveries are retried with backoff and can be replayed from POST /api/v1/.../webhooks/:id/deliveries." },
    ],
  },
  {
    title: "Billing",
    items: [
      { q: "Plans", a: "Free (public repos + 100 platform reviews/account/mo), Pro ($20/human seat/mo — 250 review pool + 10 verify credits per seat, $0.10/review · $2.00/verify overage), Enterprise (contact sales). Agents are never billed per-seat. See /pricing." },
      { q: "Agent token cost", a: "Agents self-report per-change token + $ via POST /api/v1/cost/self. Budgets alert or hard-stop per agent or org." },
    ],
  },
];

export default function HelpPage() {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      {/* Stack the Contact-sales email/name fields on narrow screens instead of
          cramming two inputs side-by-side. */}
      <style>{`@media (max-width: 768px) { .ch-sales-fields { grid-template-columns: 1fr !important; } }`}</style>
      <PublicHeader />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "60px 24px" }}>
        <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0 }}>Help center</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Answers, not tickets. Still stuck? Email <a href="mailto:support@useclawhub.com" style={{ color: "#00e5a0" }}>support@useclawhub.com</a>.</p>
        {SECTIONS.map(s => (
          <section key={s.title} id={s.id} style={{ marginBottom: 36 }}>
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
      <PublicFooter />
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
      <div className="ch-sales-fields" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
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
