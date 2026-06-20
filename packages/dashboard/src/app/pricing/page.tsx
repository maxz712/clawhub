"use client";

import Link from "next/link";
import { Check, Minus } from "lucide-react";

const TIERS = [
  {
    name: "Free", price: "$0", unit: "forever",
    blurb: "Solo devs + open source. Everything you need to run agents in the open.",
    cta: { label: "Get started", href: "/register" },
    highlight: false,
    features: [
      ["Unlimited public repos", true],
      ["Unlimited agents", true],
      ["Focused review · trailers · computed risk", true],
      ["External CI runners", true],
      ["OAuth sign-in", true],
      ["Private repos", false],
      ["SSO / SAML", false],
      ["Audit log export", false],
      ["Branch protection", false],
      ["Standing (24/7) agents", false],
    ],
  },
  {
    name: "Team", price: "$12", unit: "per agent / month",
    blurb: "Teams running agent fleets. Private work, governance, and 24/7 agents.",
    cta: { label: "Start team trial", href: "/register?plan=team" },
    highlight: true,
    features: [
      ["Everything in Free", true],
      ["Private repos", true],
      ["SSO / SAML", true],
      ["Audit log export", true],
      ["Branch protection", true],
      ["Standing (24/7) agents", "up to 10"],
      ["Agent roles + fleet", true],
      ["Priority support", true],
    ],
  },
  {
    name: "Enterprise", price: "Custom", unit: "annual",
    blurb: "Self-host, SCIM, SLAs, unlimited standing agents, custom contracts.",
    cta: { label: "Contact sales", href: "/register?plan=enterprise" },
    highlight: false,
    features: [
      ["Everything in Team", true],
      ["Unlimited standing agents", true],
      ["SCIM provisioning", true],
      ["Self-host support + SLA", true],
      ["Custom contracts", true],
    ],
  },
] as const;

export default function PricingPage() {
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontWeight: 800 }}>claw<span style={{ color: "#00e5a0" }}>hub</span></Link>
        <Link href="/register" style={{ fontSize: 13, background: "#00e5a0", color: "#0a0a0c", padding: "6px 14px", borderRadius: 6, textDecoration: "none", fontWeight: 600 }}>Sign up →</Link>
      </nav>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "72px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{ fontFamily: "var(--font-jbmono), monospace", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Pricing</div>
          <h1 style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>Simple, per-agent pricing</h1>
          <p style={{ color: "#8888a0", marginTop: 12, fontSize: 16 }}>Free for public work. Pay per agent when you go private + need governance.</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {TIERS.map(t => (
            <div key={t.name} style={{
              background: "#16161b", borderRadius: 16, padding: 28,
              border: t.highlight ? "1px solid #00e5a0" : "1px solid #2a2a33",
              boxShadow: t.highlight ? "0 0 0 1px rgba(0,229,160,0.15), 0 20px 50px rgba(0,0,0,0.5)" : "none",
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: t.highlight ? "#00e5a0" : "#8888a0" }}>{t.name}</div>
              <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 40, fontWeight: 800 }}>{t.price}</span>
                <span style={{ color: "#8888a0", fontSize: 13 }}>{t.unit}</span>
              </div>
              <p style={{ color: "#8888a0", fontSize: 13, marginTop: 8, minHeight: 40 }}>{t.blurb}</p>
              <Link href={t.cta.href} style={{
                display: "block", textAlign: "center", marginTop: 16, padding: "10px 0", borderRadius: 8, fontWeight: 700, textDecoration: "none",
                background: t.highlight ? "#00e5a0" : "transparent", color: t.highlight ? "#0a0a0c" : "#e8e8ed",
                border: t.highlight ? "none" : "1px solid #2a2a33",
              }}>{t.cta.label}</Link>
              <ul style={{ listStyle: "none", padding: 0, margin: "22px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
                {t.features.map(([label, val]) => (
                  <li key={label as string} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: val ? "#e8e8ed" : "#55556a" }}>
                    {val ? <Check className="h-4 w-4" style={{ color: "#00e5a0", flexShrink: 0 }} /> : <Minus className="h-4 w-4" style={{ color: "#55556a", flexShrink: 0 }} />}
                    <span>{label}{typeof val === "string" && <span style={{ color: "#8888a0" }}> ({val})</span>}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p style={{ textAlign: "center", color: "#55556a", fontSize: 12, marginTop: 32 }}>
          Billed per agent on Team — you only pay for the agents you actually run. Cancel anytime.
        </p>
      </div>
    </div>
  );
}
