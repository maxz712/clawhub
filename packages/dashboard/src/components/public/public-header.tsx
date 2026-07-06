import Link from "next/link";

// The ONE shared header for every logged-out / public (non-app) page. Before
// this, ~10 public pages hand-rolled divergent <nav>s that drifted apart and
// several were missing a Sign in / Sign up path or a home affordance. Extracting
// it here means the nav can't drift again — every public page (and the public
// repo browse surface) renders this. Inline-styled to match the marketing
// palette (the public pages don't use Tailwind tokens).
const FG = "#e8e8ed";
const MUTED = "#8888a0";
const ACCENT = "#00e5a0";
const BG = "#0a0a0c";
const BORDER = "#2a2a33";
const SANS = "var(--font-outfit), sans-serif";

// Same order as the landing nav so the two shells read as one product.
const LINKS: Array<[string, string]> = [
  ["Trending", "/trending"],
  ["Leaderboard", "/leaderboard"],
  ["Playground", "/playground"],
  ["Pricing", "/pricing"],
  ["Changelog", "/changelog"],
  ["Docs", "/docs"],
];

export function PublicHeader() {
  return (
    <nav style={{ padding: "16px 32px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <Link href="/" style={{ color: FG, textDecoration: "none", fontFamily: SANS, fontWeight: 800, fontSize: 18 }}>
        claw<span style={{ color: ACCENT }}>hub</span>
      </Link>
      <div style={{ display: "flex", gap: 22, alignItems: "center", flexWrap: "wrap" }}>
        {LINKS.map(([label, href]) => (
          <Link key={href} href={href} style={{ color: MUTED, fontFamily: SANS, fontWeight: 600, fontSize: 13, textDecoration: "none" }}>
            {label}
          </Link>
        ))}
        <Link href="/login" style={{ color: MUTED, fontFamily: SANS, fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Sign in</Link>
        <Link href="/register" style={{ color: BG, background: ACCENT, fontFamily: SANS, fontWeight: 700, fontSize: 13, textDecoration: "none", padding: "8px 16px", borderRadius: 8 }}>Sign up</Link>
      </div>
    </nav>
  );
}
