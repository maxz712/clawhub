"use client";

import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";
import { PRICING_TIERS } from "@/lib/pricing";

// Single-sourced from lib/pricing so this page and the landing PricingSection
// can't drift. `blurb` reuses each tier's tagline.
const TIERS = PRICING_TIERS;

export default function PricingPage() {
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "72px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{ fontFamily: "var(--font-outfit), sans-serif", color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Pricing</div>
          <h1 style={{ fontSize: 46, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>Price the humans, meter the machines</h1>
          <p style={{ color: "#8888a0", marginTop: 12, fontSize: 16 }}>Free for public work. Pay per human seat when you go private + need governance — you never pay per agent.</p>
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
              <p style={{ color: "#8888a0", fontSize: 13, marginTop: 8, minHeight: 40 }}>{t.tagline}</p>
              <Link href={t.cta.href} style={{
                display: "block", textAlign: "center", marginTop: 16, padding: "10px 0", borderRadius: 8, fontWeight: 700, textDecoration: "none",
                background: t.highlight ? "#00e5a0" : "transparent", color: t.highlight ? "#0a0a0c" : "#e8e8ed",
                border: t.highlight ? "none" : "1px solid #2a2a33",
              }}>{t.cta.label}</Link>
              <ul style={{ listStyle: "none", padding: 0, margin: "22px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
                {t.features.map(({ label, included }) => (
                  <li key={label} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: included ? "#e8e8ed" : "#55556a" }}>
                    {included ? <Check className="h-4 w-4" style={{ color: "#00e5a0", flexShrink: 0 }} /> : <Minus className="h-4 w-4" style={{ color: "#55556a", flexShrink: 0 }} />}
                    <span>{label}{typeof included === "string" && <span style={{ color: "#8888a0" }}> ({included})</span>}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p style={{ textAlign: "center", color: "#55556a", fontSize: 12, marginTop: 32 }}>
          Pro is billed per human seat — agents are free to run; platform reviews and verify runs meter against your pool. Cancel anytime.
        </p>
      </div>
      <PublicFooter />
    </div>
  );
}
