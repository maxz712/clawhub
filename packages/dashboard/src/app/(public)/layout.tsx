import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

// Layout for the logged-out PUBLIC surface — currently the read-only repo browse
// pages at /r/<ns>/<repo>/... This route group is OUTSIDE (app), so there is NO
// login gate: an anonymous visitor arriving from /trending or a profile can read
// a public repo with no redirect. The shared header/footer render once here so
// every page in the group gets consistent nav. (The standalone marketing pages
// — /trending, /leaderboard, etc. — render PublicHeader/PublicFooter themselves
// since they live at the app root with their own full-bleed backgrounds.)
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "var(--font-outfit), sans-serif" }}>
      <PublicHeader />
      <main className="flex-1 min-w-0">
        <div className="max-w-6xl mx-auto p-4 md:p-8 min-w-0">{children}</div>
      </main>
      <PublicFooter />
    </div>
  );
}
