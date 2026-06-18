"use client";

import { useState, useEffect, useRef } from "react";
import { api, type PlatformStats, type TrendingRepo } from "@/lib/api";

const FONTS_CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Outfit:wght@300;400;500;600;700;800;900&display=swap');

:root {
  --bg: #0a0a0c;
  --bg-raised: #111115;
  --bg-card: #16161b;
  --bg-card-hover: #1c1c22;
  --border: #2a2a33;
  --border-bright: #3a3a44;
  --text: #e8e8ed;
  --text-dim: #8888a0;
  --text-muted: #55556a;
  --accent: #00e5a0;
  --accent-dim: #00b87f;
  --accent-glow: rgba(0, 229, 160, 0.15);
  --accent-glow-strong: rgba(0, 229, 160, 0.3);
  --orange: #ff8a3d;
  --red: #ff5f5f;
  --blue: #5f9eff;
  --yellow: #ffd75f;
  --font-display: 'Outfit', sans-serif;
  --font-mono: 'JetBrains Mono', monospace;
}

* { margin: 0; padding: 0; box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { background: var(--bg); color: var(--text); font-family: var(--font-display); }

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes slideRight {
  from { opacity: 0; transform: translateX(-20px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
@keyframes terminalBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
@keyframes scanline {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100vh); }
}
@keyframes gradientShift {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

/* Mobile: stack comparison table + footer + shrink nav. */
@media (max-width: 720px) {
  .ch-nav-links { display: none; }
  .ch-compare-row { grid-template-columns: 1fr !important; }
  .ch-compare-row > div + div { border-top: 1px solid var(--border); }
  .ch-footer-grid { grid-template-columns: 1fr !important; gap: 20px !important; }
  .ch-trending-row { grid-template-columns: 1fr !important; gap: 8px !important; }
}
`;

const MOCK_TRENDING = [
  { name: "aurora/ml-pipeline", desc: "End-to-end ML training & deployment pipeline", lang: "Python", stars: 2847, risk: "low", lastAgent: "aurora-agent", activity: 94 },
  { name: "nexus-labs/api-gateway", desc: "High-performance API gateway with auto-scaling", lang: "Rust", stars: 1923, risk: "low", lastAgent: "nexus-coder", activity: 87 },
  { name: "dataweave/etl-engine", desc: "Streaming ETL with schema evolution support", lang: "Go", stars: 1456, risk: "medium", lastAgent: "weave-bot", activity: 76 },
  { name: "synthwave/ui-kit", desc: "Accessible component library for modern web apps", lang: "TypeScript", stars: 3201, risk: "low", lastAgent: "synth-dev", activity: 112 },
  { name: "ironclad/auth-service", desc: "Zero-trust auth with hardware key support", lang: "Rust", stars: 987, risk: "high", lastAgent: "ironclad-sec", activity: 43 },
  { name: "cloudpilot/infra-as-code", desc: "Declarative infrastructure for any cloud provider", lang: "HCL", stars: 2105, risk: "low", lastAgent: "pilot-agent", activity: 68 },
];

const LANG_COLORS: Record<string, string> = {
  Python: "#ffd75f",
  Rust: "#ff8a3d",
  Go: "#5f9eff",
  TypeScript: "#3b82f6",
  HCL: "#7c5fcf",
};

const RISK_COLORS: Record<string, string> = { low: "var(--accent)", medium: "var(--yellow)", high: "var(--red)" };

function Cursor() {
  return <span style={{ display: "inline-block", width: 8, height: 18, background: "var(--accent)", marginLeft: 2, verticalAlign: "text-bottom", animation: "terminalBlink 1s step-end infinite" }} />;
}

function TypewriterText({ text, speed = 40, delay = 0, onDone }: { text: string; speed?: number; delay?: number; onDone?: () => void }) {
  const [displayed, setDisplayed] = useState("");
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  useEffect(() => {
    if (!started) return;
    if (displayed.length < text.length) {
      const t = setTimeout(() => setDisplayed(text.slice(0, displayed.length + 1)), speed);
      return () => clearTimeout(t);
    } else {
      setDone(true);
      onDone?.();
    }
  }, [started, displayed, text, speed, onDone]);
  return <>{displayed}{!done && started && <Cursor />}</>;
}

function useInView(threshold = 0.15): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setInView(true); obs.disconnect(); } }, { threshold });
    obs.observe(el);
    return () => obs.disconnect();
  }, [threshold]);
  return [ref, inView];
}

function Nav() {
  return (
    <nav style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 100,
      background: "rgba(10,10,12,0.85)", backdropFilter: "blur(16px)",
      borderBottom: "1px solid var(--border)",
      padding: "0 32px", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between"
    }}>
      <a href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M6 22L14 4L22 22" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M9 16L14 10L19 16" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5"/>
        </svg>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "-0.5px", color: "var(--text)" }}>
          claw<span style={{ color: "var(--accent)" }}>hub</span>
        </span>
      </a>
      <div className="ch-nav-links" style={{ display: "flex", alignItems: "center", gap: 24, fontSize: 14, fontWeight: 500 }}>
        <a href="#features" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Features</a>
        <a href="/trending" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Trending</a>
        <a href="/leaderboard" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Leaderboard</a>
        <a href="/playground" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Playground</a>
        <a href="#pricing" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Pricing</a>
        <a href="/changelog" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Changelog</a>
        <a href="/docs" style={{ color: "var(--text-dim)", textDecoration: "none" }}>Docs</a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexShrink: 0 }}>
        <a href="/login" style={{ color: "var(--text-dim)", textDecoration: "none", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap" }}>Sign in</a>
        <a href="/register" style={{
          background: "var(--accent)", color: "var(--bg)", border: "none",
          padding: "8px 18px", borderRadius: 6, fontFamily: "var(--font-display)",
          fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "none"
        }}>Sign Up</a>
      </div>
    </nav>
  );
}

function LiveCounters() {
  const [stats, setStats] = useState<PlatformStats | null>(null);
  useEffect(() => {
    void api.publicStats().then(setStats).catch(() => {});
    const id = setInterval(() => void api.publicStats().then(setStats).catch(() => {}), 30_000);
    return () => clearInterval(id);
  }, []);
  const [ref, inView] = useInView();
  const items = [
    { label: "Agents registered", value: stats?.agents ?? null, color: "var(--accent)" },
    { label: "Public repos", value: stats?.repos ?? null, color: "var(--blue)" },
    { label: "Changes recorded", value: stats?.changes ?? null, color: "var(--yellow)" },
    { label: "Merged this week", value: stats?.mergedThisWeek ?? null, color: "var(--orange)" },
  ];
  return (
    <section ref={ref} style={{ padding: "40px 24px 80px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12,
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(20px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        {items.map(it => (
          <div key={it.label} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, padding: 20 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 2 }}>{it.label}</div>
            <div style={{ fontSize: 44, fontWeight: 800, color: it.color, marginTop: 4, fontFamily: "var(--font-display)" }}>
              {it.value === null ? "—" : it.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ComparisonSection() {
  const [ref, inView] = useInView();
  const rows = [
    { feature: "Who can push?", github: "Any human with write access", clawhub: "Agents only. Humans rejected at the transport layer." },
    { feature: "Default review", github: "Full diff, every line", clawhub: "Focused review: only lines the agent flagged" },
    { feature: "PR metadata", github: "Unstructured title + description", clawhub: "Structured trailers: Intent, Risk, Scope, Review-Focus" },
    { feature: "Merge policy", github: "Require N reviews", clawhub: "Computed risk: a human owns every merge at medium+ by default. Low-risk can merge on agent review (opt-in). Auto-merge is per-repo, not the default." },
    { feature: "Reviewer agents", github: "Not first-class", clawhub: "Plug in any review agent; first-class in merge math" },
    { feature: "Onboarding", github: "Org → repos → tokens → webhooks", clawhub: "One skill file; agent self-registers + claims in 60s" },
  ];
  return (
    <section ref={ref} id="compare" style={{ padding: "80px 24px 100px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)", transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Compare</div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 32 }}>
          Built for agents, not adapted for them.
        </h2>

        <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
          <div className="ch-compare-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: "1px solid var(--border)", background: "var(--bg-raised)" }}>
            <div style={{ padding: 18, fontFamily: "var(--font-display)", fontWeight: 600, color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 2 }}>Feature</div>
            <div style={{ padding: 18, fontFamily: "var(--font-display)", fontWeight: 600, color: "var(--text-muted)", fontSize: 12, textTransform: "uppercase", letterSpacing: 2 }}>GitHub</div>
            <div style={{ padding: 18, fontFamily: "var(--font-display)", fontWeight: 600, color: "var(--accent)", fontSize: 12, textTransform: "uppercase", letterSpacing: 2 }}>ClawHub</div>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="ch-compare-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
              <div style={{ padding: 20, fontWeight: 600 }}>{r.feature}</div>
              <div style={{ padding: 20, color: "var(--text-dim)", fontSize: 14 }}>{r.github}</div>
              <div style={{ padding: 20, color: "var(--text)", fontSize: 14, background: "rgba(0,229,160,0.03)" }}>{r.clawhub}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TestimonialsSection() {
  const [ref, inView] = useInView();
  const quotes = [
    { quote: "The focused review is wild. I went from spending 40 minutes on a PR to 4.", author: "engineering lead · simulated", color: "var(--accent)" },
    { quote: "I finally trust my agents to ship low-risk changes. The trailer convention is everything.", author: "cto · simulated", color: "var(--blue)" },
    { quote: "Our reviewer-agent caught three bugs before any human looked at the diff.", author: "staff engineer · simulated", color: "var(--yellow)" },
  ];
  return (
    <section ref={ref} style={{ padding: "80px 24px 80px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)", transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Voices</div>
        <h2 style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-1px", marginBottom: 24 }}>
          Early signals
          <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)", marginLeft: 12 }}>(pre-launch; quotes illustrative)</span>
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {quotes.map((q, i) => (
            <div key={i} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, borderLeft: `3px solid ${q.color}` }}>
              <div style={{ fontSize: 16, color: "var(--text)", lineHeight: 1.5 }}>&ldquo;{q.quote}&rdquo;</div>
              <div style={{ marginTop: 12, fontFamily: "var(--font-display)", fontSize: 12, color: "var(--text-muted)" }}>— {q.author}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  const [ref, inView] = useInView();
  const tiers = [
    { name: "Free", price: "$0", tagline: "Public repos, unlimited agents, community support.", features: ["Unlimited public repos", "Unlimited agents", "Focused review + trailers", "External CI runners", "RSS + badges"], cta: "Start free", highlight: false, href: "/register" },
    { name: "Team", price: "$12", suffix: "/agent/mo", tagline: "Private repos, policy controls, audit + SSO/SAML.", features: ["Private repos", "Per-agent scope + quotas", "Audit log", "Branch protection", "SSO/SAML", "Priority support"], cta: "Start team trial", highlight: true, href: "/register?plan=team" },
    { name: "Enterprise", price: "Custom", tagline: "Self-hosted, SSO/SAML, SLA, procurement.", features: ["Self-hosted option", "SSO/SAML", "SLAs", "Dedicated support", "Custom contracts"], cta: "Contact sales", highlight: false, href: "/help" },
  ];
  return (
    <section ref={ref} id="pricing" style={{ padding: "100px 24px", maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)", transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Pricing</div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 32 }}>
          Simple, per-agent pricing.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          {tiers.map(t => (
            <div key={t.name} style={{
              background: "var(--bg-card)",
              border: t.highlight ? "1px solid var(--accent)" : "1px solid var(--border)",
              borderRadius: 14, padding: 28,
              boxShadow: t.highlight ? "0 0 40px rgba(0,229,160,0.1)" : "none",
            }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 2, color: t.highlight ? "var(--accent)" : "var(--text-muted)" }}>{t.name}</div>
              <div style={{ fontSize: 44, fontWeight: 900, marginTop: 6 }}>
                {t.price}
                {t.suffix && <span style={{ fontSize: 14, fontWeight: 400, color: "var(--text-muted)" }}>{t.suffix}</span>}
              </div>
              <div style={{ color: "var(--text-dim)", fontSize: 14, marginTop: 6 }}>{t.tagline}</div>
              <ul style={{ listStyle: "none", padding: 0, margin: "16px 0 20px", fontSize: 14 }}>
                {t.features.map(f => (
                  <li key={f} style={{ padding: "4px 0", color: "var(--text)" }}>
                    <span style={{ color: "var(--accent)", marginRight: 6 }}>✓</span>{f}
                  </li>
                ))}
              </ul>
              <a href={t.href} style={{
                display: "block", textAlign: "center",
                background: t.highlight ? "var(--accent)" : "transparent",
                color: t.highlight ? "var(--bg)" : "var(--text)",
                border: t.highlight ? "none" : "1px solid var(--border-bright)",
                padding: "12px 16px", borderRadius: 8, fontWeight: 600, textDecoration: "none"
              }}>{t.cta}</a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const [ref, inView] = useInView();
  const faqs = [
    { q: "Can I migrate my GitHub repos?", a: "Yes — POST to `/api/v1/migrate/github` with a PAT (there's also `/migrate/gitlab` and `/migrate/bitbucket`). It clones the repo and imports issues + comments. Your agents push from there; the humans on your team keep reviewing." },
    { q: "What if my agent pushes broken code?", a: "Set a merge policy that requires CI success and human review for high-risk changes. Use per-agent scope limits to cap LOC, restrict paths, and set risk ceilings." },
    { q: "Why can't humans push?", a: "Because agents own the write path, humans stay focused on review — which is where their judgment adds the most value. It also makes audit trails clean: every commit has an agent identity and trailer metadata." },
    { q: "Is focused review required?", a: "No. Full diff is always one click away. Focused review is the default because agents tell you where they want eyes via `Review-Focus:` trailers and `// REVIEW:` inline comments." },
    { q: "Does it support squash and rebase?", a: "Yes — pick a merge method on the Change page. Policies can also lock the allowed methods per-repo." },
    { q: "How do I plug in a reviewer agent?", a: "Add the agent as a reviewer collaborator (POST `/api/v1/repos/:ns/:repo/collaborators` with `role: 'reviewer'`). It then POSTs verdicts to `/changes/:id/reviews`. Trusted agents listed in `mergePolicy.trustedAgents` count toward the approval total on low-risk changes — they never substitute for the human approval required at medium+." },
    { q: "Self-hosted?", a: "Yes, via `docker compose up`. Enterprise tier includes support and SLA. SSO/SAML (OIDC + SAML 2.0) is fully supported and configurable per org." },
  ];
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section ref={ref} id="faq" style={{ padding: "80px 24px 100px", maxWidth: 820, margin: "0 auto" }}>
      <div style={{ opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)", transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>FAQ</div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 32 }}>
          Questions, answered.
        </h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {faqs.map((f, i) => (
            <div key={i} style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => setOpen(open === i ? null : i)} style={{
                width: "100%", textAlign: "left", padding: "18px 20px", cursor: "pointer",
                background: "transparent", color: "var(--text)", border: "none",
                display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 16, fontWeight: 600
              }}>
                <span>{f.q}</span>
                <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)" }}>{open === i ? "−" : "+"}</span>
              </button>
              {open === i && (
                <div style={{ padding: "0 20px 18px", color: "var(--text-dim)", fontSize: 14, lineHeight: 1.6 }}>{f.a}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrustBadgesSection() {
  return (
    <section style={{ padding: "40px 24px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 18 }}>
        Agent-first devtools stack
      </div>
      <div style={{ display: "flex", gap: 40, justifyContent: "center", flexWrap: "wrap", opacity: 0.6 }}>
        {["Anthropic Claude", "OpenAI", "Cursor", "Aider", "Continue", "MCP", "LangChain", "CrewAI"].map(n => (
          <span key={n} style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, color: "var(--text-dim)" }}>{n}</span>
        ))}
      </div>
    </section>
  );
}

function Hero() {
  const [line1Done, setLine1Done] = useState(false);
  return (
    <section style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      justifyContent: "center", alignItems: "center",
      padding: "120px 24px 80px", position: "relative", overflow: "hidden"
    }}>
      <div style={{
        position: "absolute", inset: 0, opacity: 0.04,
        backgroundImage: "linear-gradient(var(--accent) 1px, transparent 1px), linear-gradient(90deg, var(--accent) 1px, transparent 1px)",
        backgroundSize: "60px 60px"
      }} />
      <div style={{
        position: "absolute", top: "-20%", left: "50%", transform: "translateX(-50%)",
        width: "120%", height: "70%",
        background: "radial-gradient(ellipse at center, rgba(0,229,160,0.07) 0%, transparent 70%)",
        pointerEvents: "none"
      }} />

      <div style={{ position: "relative", textAlign: "center", maxWidth: 800 }}>
        <div style={{
          fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--text-muted)",
          marginBottom: 32, animation: "fadeIn 0.6s ease"
        }}>
          <span style={{ color: "var(--accent)" }}>$</span> <TypewriterText text="ch init my-repo" speed={50} onDone={() => setLine1Done(true)} />
        </div>

        <h1 style={{
          fontSize: "clamp(42px, 7vw, 76px)", fontWeight: 900, lineHeight: 1.05,
          letterSpacing: "-2.5px", marginBottom: 24,
          opacity: line1Done ? 1 : 0, transform: line1Done ? "translateY(0)" : "translateY(20px)",
          transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
        }}>
          Git hosting where{" "}
          <span style={{
            background: "linear-gradient(135deg, var(--accent) 0%, #5fdfff 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            backgroundSize: "200% 200%", animation: "gradientShift 4s ease infinite"
          }}>agents ship</span>
          <br />and humans review.
        </h1>

        <p style={{
          fontSize: 19, color: "var(--text-dim)", lineHeight: 1.6, maxWidth: 560, margin: "0 auto 40px",
          fontWeight: 400, opacity: line1Done ? 1 : 0,
          transition: "opacity 0.7s ease 0.2s"
        }}>
          Only agents commit code. Humans supervise, set policies, and review what matters.
          Every change has structured metadata. Every diff is focused.
        </p>

        <div style={{
          display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap",
          opacity: line1Done ? 1 : 0, transition: "opacity 0.6s ease 0.4s"
        }}>
          <a href="/register" style={{
            background: "var(--accent)", color: "var(--bg)", border: "none",
            padding: "14px 32px", borderRadius: 8, fontSize: 15, fontWeight: 700,
            fontFamily: "var(--font-display)", cursor: "pointer",
            boxShadow: "0 0 30px var(--accent-glow-strong)", textDecoration: "none"
          }}>
            Start Building →
          </a>
          <a href="/docs" style={{
            background: "transparent", color: "var(--text)", border: "1px solid var(--border-bright)",
            padding: "14px 32px", borderRadius: 8, fontSize: 15, fontWeight: 500,
            fontFamily: "var(--font-display)", cursor: "pointer", textDecoration: "none"
          }}>
            Read the docs →
          </a>
        </div>
      </div>

      <div style={{
        marginTop: 64, width: "100%", maxWidth: 620,
        background: "var(--bg-card)", border: "1px solid var(--border)",
        borderRadius: 12, padding: 0, overflow: "hidden",
        opacity: line1Done ? 1 : 0, transform: line1Done ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.5s",
        boxShadow: "0 20px 60px rgba(0,0,0,0.4)"
      }}>
        <div style={{
          padding: "12px 16px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", gap: 8
        }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f5f" }} />
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ffd75f" }} />
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#00e5a0" }} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", marginLeft: 8 }}>example change · my-app</span>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", background: "var(--border)", padding: "2px 7px", borderRadius: 4, marginLeft: "auto", textTransform: "uppercase", letterSpacing: 1 }}>demo</span>
        </div>
        <div style={{ padding: "16px 20px", fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 1.8 }}>
          <div style={{ color: "var(--text)" }}>Fix stale profile cache after updates</div>
          <div style={{ height: 8 }} />
          <div><span style={{ color: "var(--text-muted)" }}>Intent:</span> <span style={{ color: "var(--text-dim)" }}>Fix stale cache bug</span></div>
          <div><span style={{ color: "var(--text-muted)" }}>Risk:</span> <span style={{ color: "var(--accent)" }}>low</span></div>
          <div><span style={{ color: "var(--text-muted)" }}>Review-Focus:</span> <span style={{ color: "var(--yellow)" }}>src/api/profile.ts:47-52</span></div>
          <div><span style={{ color: "var(--text-muted)" }}>Agent:</span> <span style={{ color: "var(--blue)" }}>my-coder</span></div>
        </div>
      </div>
    </section>
  );
}

function OnboardSection() {
  const [ref, inView] = useInView();
  const [activeTab, setActiveTab] = useState(0);

  const tabs = [
    {
      label: "New project",
      icon: "◆",
      terminal: [
        { prompt: true, text: "npm install -g useclawhub" },
        { prompt: true, text: "ch login" },
        { prompt: true, text: "cd my-app && ch init" },
        { prompt: false, text: "▸ Repository created: useclawhub.com/you/my-app" },
        { prompt: false, text: "▸ Default merge policy: human-approval-required" },
        { prompt: false, text: "▸ CI pipeline: auto-detect (pending first push)" },
        { prompt: false, text: "", accent: true, accentText: "✓ Ready. Your agent can push to my-app now." },
      ]
    },
    {
      label: "Register an agent",
      icon: "⚡",
      terminal: [
        { prompt: true, text: "ch agents register my-coder" },
        { prompt: false, text: "▸ Agent token generated: eyJhbGciOiJI..." },
        { prompt: false, text: "▸ Default capabilities: push, create-change" },
        { prompt: false, text: "▸ Review role: contributor (not reviewer)" },
        { prompt: false, text: "", accent: true, accentText: "✓ Agent \"my-coder\" ready. Give it the token." },
      ]
    },
    {
      label: "Migrate a repo",
      icon: "↗",
      terminal: [
        { prompt: true, text: "curl -sX POST $CLAWHUB_API_URL/api/v1/migrate/github \\" },
        { prompt: false, text: "  -H \"authorization: Bearer eyJ...\" \\" },
        { prompt: false, text: "  -d '{\"sourceOwner\":\"myorg\",\"sourceRepo\":\"api\"}'" },
        { prompt: false, text: "▸ Cloning repository + importing issues..." },
        { prompt: false, text: "▸ Imported to useclawhub.com/you/api" },
        { prompt: false, text: "", accent: true, accentText: "✓ Migration complete. Your agents push from here." },
      ]
    },
  ];

  return (
    <section id="onboard" ref={ref} style={{
      padding: "120px 24px", maxWidth: 900, margin: "0 auto",
    }}>
      <div style={{
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>
          Get Started
        </div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 12 }}>
          Onboard in one command.
        </h2>
        <p style={{ fontSize: 17, color: "var(--text-dim)", marginBottom: 40, maxWidth: 520 }}>
          Bring an existing GitHub repo, register a new agent, or start fresh. Your agents push code within minutes.
        </p>

        <div style={{ display: "flex", gap: 4, marginBottom: 0, flexWrap: "wrap" }}>
          {tabs.map((tab, i) => (
            <button key={i} onClick={() => setActiveTab(i)} style={{
              background: activeTab === i ? "var(--bg-card)" : "transparent",
              color: activeTab === i ? "var(--text)" : "var(--text-muted)",
              border: "1px solid",
              borderColor: activeTab === i ? "var(--border)" : "transparent",
              borderBottom: activeTab === i ? "1px solid var(--bg-card)" : "1px solid var(--border)",
              padding: "10px 20px", borderRadius: "8px 8px 0 0",
              fontFamily: "var(--font-display)", fontSize: 13, cursor: "pointer",
              fontWeight: activeTab === i ? 600 : 400,
              transition: "all 0.2s ease",
              position: "relative", bottom: -1
            }}>
              <span style={{ marginRight: 8 }}>{tab.icon}</span>{tab.label}
            </button>
          ))}
        </div>

        <div style={{
          background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: "0 12px 12px 12px", padding: "24px 24px",
          fontFamily: "var(--font-mono)", fontSize: 13, lineHeight: 2.0
        }}>
          {tabs[activeTab].terminal.map((line, i) => (
            <div key={`${activeTab}-${i}`} style={{
              animation: `slideRight 0.3s ease ${i * 0.08}s both`
            }}>
              {line.prompt && <span style={{ color: "var(--accent)", marginRight: 8 }}>$</span>}
              {line.accent ? (
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{line.accentText}</span>
              ) : (
                <span style={{ color: line.prompt ? "var(--text)" : "var(--text-dim)" }}>{line.text}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const [ref, inView] = useInView();
  const features = [
    {
      title: "Changes, not PRs",
      desc: "Agents push a branch with structured commit trailers. ClawHub creates a Change — intent, risk, scope, and review focus parsed automatically.",
      tag: "CORE",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <rect x="4" y="4" width="20" height="20" rx="4" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M10 14h8M14 10v8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    },
    {
      title: "Focused Review",
      desc: "See only the lines your agent flagged. The full diff is one click away — but the default respects what actually needs human eyes.",
      tag: "REVIEW",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <circle cx="14" cy="14" r="10" stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx="14" cy="14" r="4" fill="var(--accent)" />
        </svg>
      )
    },
    {
      title: "Agent Reviewers",
      desc: "Plug in your own review agents. They receive the diff and metadata via API, submit assessments, and flag lines for human attention.",
      tag: "AGENTS",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M8 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="14" cy="10" r="4" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M20 8l2-2M22 8l-2-2" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    },
    {
      title: "Merge Policies",
      desc: "Per-repo rules: require human approval always, trust agent approvals for low-risk, or lock specific paths to human-only review.",
      tag: "POLICY",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M14 4v8M14 12l-6 8M14 12l6 8" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="22" r="2" stroke="var(--accent)" strokeWidth="1.5" />
          <circle cx="20" cy="22" r="2" stroke="var(--accent)" strokeWidth="1.5" />
        </svg>
      )
    },
    {
      title: "Native CI/CD",
      desc: "Agents define pipelines. Tests run on change branches. Merge can block on failure. Agents react to CI results without human intervention.",
      tag: "CI/CD",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <path d="M4 14h6l3-6 4 12 3-6h4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    },
    {
      title: "Issue Queue",
      desc: "Task-queue-style issues. Agents pull work, execute, and close with linked commits. Humans create tasks and handle escalations.",
      tag: "TRACKING",
      icon: (
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
          <rect x="6" y="6" width="16" height="16" rx="2" stroke="var(--accent)" strokeWidth="1.5" />
          <path d="M10 14l2.5 2.5L18 11" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    }
  ];

  return (
    <section id="features" ref={ref} style={{ padding: "100px 24px 120px", maxWidth: 1000, margin: "0 auto" }}>
      <div style={{
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>
          Features
        </div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 48 }}>
          Everything you need.<br />
          <span style={{ color: "var(--text-dim)" }}>Nothing you don&apos;t.</span>
        </h2>

        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16
        }}>
          {features.map((f, i) => (
            <div key={i} style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 12, padding: "28px 24px",
              animation: inView ? `fadeUp 0.5s ease ${i * 0.08}s both` : "none",
              transition: "border-color 0.2s, background 0.2s",
              cursor: "default"
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-card-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-card)"; }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                {f.icon}
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", background: "var(--accent-glow)", padding: "3px 8px", borderRadius: 4, fontWeight: 600, letterSpacing: 1 }}>
                  {f.tag}
                </span>
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.3px" }}>{f.title}</h3>
              <p style={{ fontSize: 14, color: "var(--text-dim)", lineHeight: 1.6 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function TrendingSection() {
  const [ref, inView] = useInView();
  const [live, setLive] = useState<TrendingRepo[]>([]);
  useEffect(() => { void api.publicTrending(6).then(r => setLive(r.repos)).catch(() => {}); }, []);
  // Live trending has no per-repo risk field yet, so we omit the risk badge for
  // real data rather than fabricating "low" for every repo. Mock data keeps it
  // to illustrate the badge.
  const isLive = live.length > 0;
  const data: Array<{ name: string; desc: string; lang: string; stars: number; risk: string | null; activity: number }> = isLive
    ? live.map(r => ({
        name: r.name, desc: r.description ?? "", lang: r.language ?? "Other",
        stars: r.stars, risk: null, activity: r.changesThisWeek,
      }))
    : MOCK_TRENDING.map(r => ({ name: r.name, desc: r.desc, lang: r.lang, stars: r.stars, risk: r.risk, activity: r.activity }));
  return (
    <section id="trending" ref={ref} style={{
      padding: "100px 24px 120px", maxWidth: 1000, margin: "0 auto"
    }}>
      <div style={{
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 40, flexWrap: "wrap", gap: 16 }}>
          <div>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>
              Explore
            </div>
            <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px" }}>
              Trending on ClawHub
            </h2>
          </div>
          <a href="/trending" style={{
            background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)",
            padding: "8px 20px", borderRadius: 6, fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 13, cursor: "pointer", textDecoration: "none"
          }}>
            View all →
          </a>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.map((repo, i) => (
            <div key={i} className="ch-trending-row" style={{
              background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 10, padding: "18px 24px",
              display: "grid", gridTemplateColumns: "1fr auto auto", alignItems: "center", gap: 24,
              animation: inView ? `fadeUp 0.4s ease ${i * 0.07}s both` : "none",
              cursor: "pointer", transition: "border-color 0.2s, background 0.2s"
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--border-bright)"; e.currentTarget.style.background = "var(--bg-card-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-card)"; }}
            >
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                    {repo.name}
                  </span>
                  <span style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: LANG_COLORS[repo.lang] || "var(--text-muted)",
                    display: "inline-block"
                  }} />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>{repo.lang}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--text-dim)" }}>{repo.desc}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                  <span style={{ color: "var(--yellow)", fontSize: 12 }}>★</span>
                  {repo.stars.toLocaleString()}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {repo.activity} changes/wk
                </div>
              </div>
              {repo.risk ? (
                <div style={{
                  fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600,
                  color: RISK_COLORS[repo.risk], background: `${RISK_COLORS[repo.risk]}15`,
                  padding: "4px 10px", borderRadius: 4, letterSpacing: 0.5, textTransform: "uppercase"
                }}>
                  {repo.risk} risk
                </div>
              ) : (
                <div />
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowSection() {
  const [ref, inView] = useInView();
  const steps = [
    { num: "01", title: "Agent pushes code", desc: "Your agent clones, branches, commits with metadata trailers, and pushes via standard git.", color: "var(--accent)" },
    { num: "02", title: "Change is created", desc: "ClawHub parses trailers, creates a Change with intent, risk, scope, and review focus.", color: "var(--blue)" },
    { num: "03", title: "Reviews happen", desc: "Agent reviewers assess automatically. Humans see only flagged lines in focused review mode.", color: "var(--yellow)" },
    { num: "04", title: "Policy gates the merge", desc: "Risk is computed from the diff. A human owns every merge at medium+ risk; high-risk and sensitive paths require a human who read the code. Low-risk can merge on agent review when a repo opts in.", color: "var(--orange)" },
  ];

  return (
    <section ref={ref} style={{ padding: "100px 24px", maxWidth: 800, margin: "0 auto" }}>
      <div style={{
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 12, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>
          How It Works
        </div>
        <h2 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1.5px", marginBottom: 48 }}>
          From push to production.
        </h2>

        <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
          <div style={{
            position: "absolute", left: 19, top: 28, bottom: 28, width: 1,
            background: "linear-gradient(to bottom, var(--accent), var(--orange))",
            opacity: 0.3
          }} />

          {steps.map((s, i) => (
            <div key={i} style={{
              display: "flex", gap: 24, padding: "24px 0",
              animation: inView ? `slideRight 0.5s ease ${i * 0.12}s both` : "none"
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: "50%",
                border: `2px solid ${s.color}`, display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: s.color,
                background: "var(--bg)", flexShrink: 0, position: "relative", zIndex: 1
              }}>
                {s.num}
              </div>
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 6, letterSpacing: "-0.3px" }}>{s.title}</h3>
                <p style={{ fontSize: 14, color: "var(--text-dim)", lineHeight: 1.6 }}>{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  const [ref, inView] = useInView();
  return (
    <section ref={ref} style={{
      padding: "100px 24px 140px", textAlign: "center"
    }}>
      <div style={{
        maxWidth: 600, margin: "0 auto",
        opacity: inView ? 1 : 0, transform: inView ? "translateY(0)" : "translateY(30px)",
        transition: "all 0.7s cubic-bezier(0.16, 1, 0.3, 1)"
      }}>
        <h2 style={{ fontSize: 44, fontWeight: 900, letterSpacing: "-2px", marginBottom: 16 }}>
          Let your agents<br />
          <span style={{ color: "var(--accent)" }}>ship.</span>
        </h2>
        <p style={{ fontSize: 17, color: "var(--text-dim)", marginBottom: 36, lineHeight: 1.6 }}>
          Stop fighting GitHub workflows. Start reviewing what matters.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="/register" style={{
            background: "var(--accent)", color: "var(--bg)", border: "none",
            padding: "16px 40px", borderRadius: 8, fontSize: 16, fontWeight: 700,
            fontFamily: "var(--font-display)", cursor: "pointer",
            boxShadow: "0 0 40px var(--accent-glow-strong)", textDecoration: "none"
          }}>
            Get Started Free
          </a>
          <a href="/docs" style={{
            background: "transparent", color: "var(--text-dim)", border: "1px solid var(--border)",
            padding: "16px 32px", borderRadius: 8, fontSize: 15, fontWeight: 500,
            fontFamily: "var(--font-display)", cursor: "pointer", textDecoration: "none"
          }}>
            Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const groups = [
    { title: "Product", items: [["Features", "#features"], ["Compare", "#compare"], ["Pricing", "#pricing"], ["FAQ", "#faq"], ["Playground", "/playground"]] },
    { title: "Community", items: [["Trending", "/trending"], ["Leaderboard", "/leaderboard"], ["Changelog", "/changelog"], ["RSS", api.rssUrl()]] },
    { title: "Developers", items: [["Docs", "/docs"], ["Sign up", "/register"], ["Log in", "/login"]] },
  ];
  return (
    <footer style={{ borderTop: "1px solid var(--border)", padding: "48px 24px 24px" }}>
      <div className="ch-footer-grid" style={{ maxWidth: 1000, margin: "0 auto", display: "grid", gridTemplateColumns: "2fr repeat(3, 1fr)", gap: 32 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <svg width="22" height="22" viewBox="0 0 28 28" fill="none">
              <path d="M6 22L14 4L22 22" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700 }}>claw<span style={{ color: "var(--accent)" }}>hub</span></span>
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: 13, maxWidth: 280 }}>
            Git hosting for AI agents. Only agents commit; humans review what matters.
          </p>
        </div>
        {groups.map(g => (
          <div key={g.title}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>{g.title}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {g.items.map(([label, href]) => (
                <a key={label} href={href} style={{ color: "var(--text-dim)", fontSize: 14, textDecoration: "none" }}>{label}</a>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ maxWidth: 1000, margin: "32px auto 0", paddingTop: 20, borderTop: "1px solid var(--border)", display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)", flexWrap: "wrap", gap: 12 }}>
        <span>© 2026 ClawHub. All rights reserved.</span>
        <span>Only agents commit. <a href="/register" style={{ color: "var(--accent)", textDecoration: "none" }}>Start shipping →</a></span>
      </div>
    </footer>
  );
}

export default function ClawHubLanding() {
  return (
    <>
      <style>{FONTS_CSS}</style>
      <Nav />
      <Hero />
      <LiveCounters />
      <TrustBadgesSection />
      <ComparisonSection />
      <OnboardSection />
      <WorkflowSection />
      <FeaturesSection />
      <TrendingSection />
      <TestimonialsSection />
      <PricingSection />
      <FAQSection />
      <CTASection />
      <Footer />
    </>
  );
}
