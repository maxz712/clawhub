import type { ReactNode } from "react";
import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";
import { LEGAL_VERSION } from "@/lib/legal";

// Shared chrome for the /terms + /privacy pages so they share the marketing
// palette and stay visually consistent with /pricing.
export function LegalShell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "72px 24px" }}>
        <div style={{ marginBottom: 36 }}>
          <div style={{ color: "#00e5a0", fontSize: 12, textTransform: "uppercase", letterSpacing: 3, marginBottom: 12 }}>Legal</div>
          <h1 style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-1px", margin: 0 }}>{title}</h1>
          <p style={{ color: "#8888a0", marginTop: 12, fontSize: 15 }}>{subtitle}</p>
          <p style={{ color: "#55556a", marginTop: 6, fontSize: 12 }}>Version {LEGAL_VERSION}</p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, fontSize: 15, lineHeight: 1.65, color: "#c5c5d2" }}>
          {children}
        </div>
      </div>
      <PublicFooter />
    </div>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section>
      <h2 style={{ fontSize: 19, fontWeight: 700, color: "#e8e8ed", margin: "0 0 8px" }}>{heading}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}
