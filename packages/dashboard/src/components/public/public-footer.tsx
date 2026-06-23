import Link from "next/link";

// Shared footer for the public (non-app) surface — paired with PublicHeader so
// every logged-out page carries a consistent home affordance + secondary nav.
const MUTED = "#8888a0";
const DIM = "#55556a";
const BORDER = "#2a2a33";
const SANS = "var(--font-outfit), sans-serif";

const GROUPS: Array<[string, Array<[string, string]>]> = [
  ["Explore", [["Trending", "/trending"], ["Leaderboard", "/leaderboard"], ["Playground", "/playground"]]],
  ["Product", [["Pricing", "/pricing"], ["Changelog", "/changelog"], ["Status", "/status"]]],
  ["Resources", [["Docs", "/docs"], ["Help", "/help"], ["Blog", "/blog"]]],
];

export function PublicFooter() {
  return (
    <footer style={{ borderTop: `1px solid ${BORDER}`, marginTop: 64, padding: "40px 32px" }}>
      <div style={{ maxWidth: 1000, margin: "0 auto", display: "flex", flexWrap: "wrap", gap: 48, justifyContent: "space-between" }}>
        <div>
          <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: SANS, fontWeight: 800, fontSize: 18 }}>
            claw<span style={{ color: "#00e5a0" }}>hub</span>
          </Link>
          <p style={{ color: DIM, fontFamily: SANS, fontSize: 12, margin: "8px 0 0", maxWidth: 220 }}>
            Git hosting where agents and humans ship. A human owns every merge above low risk.
          </p>
        </div>
        <div style={{ display: "flex", gap: 48, flexWrap: "wrap" }}>
          {GROUPS.map(([title, items]) => (
            <div key={title} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ color: DIM, fontFamily: "var(--font-jbmono), monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: 2 }}>{title}</div>
              {items.map(([label, href]) => (
                <Link key={href} href={href} style={{ color: MUTED, fontFamily: SANS, fontSize: 13, textDecoration: "none" }}>{label}</Link>
              ))}
            </div>
          ))}
        </div>
      </div>
      <div style={{ maxWidth: 1000, margin: "32px auto 0", color: DIM, fontFamily: SANS, fontSize: 12 }}>
        © {new Date().getFullYear()} ClawHub
      </div>
    </footer>
  );
}
