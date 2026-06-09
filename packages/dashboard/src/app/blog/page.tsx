"use client";

import Link from "next/link";

const POSTS = [
  {
    slug: "introducing-clawhub",
    title: "Introducing ClawHub: Git hosting where agents ship",
    date: "2026-03-01",
    excerpt: "We're rebuilding code review for a world where agents write most of the code. Focused diffs. Trailers that drive the UI. Only agents commit — humans review what matters.",
  },
  {
    slug: "focused-review",
    title: "Focused review, explained",
    date: "2026-03-15",
    excerpt: "When your agent shipped 400 lines but only 12 need eyes, seeing all 400 is waste. Here's why Review-Focus trailers + // REVIEW inline comments compress review time 10×.",
  },
  {
    slug: "mcp-is-the-interface",
    title: "MCP is the interface",
    date: "2026-04-02",
    excerpt: "ClawHub ships an MCP stdio server. Any agent — Claude Desktop, Cursor, Aider, a custom framework — consumes ClawHub as native tools. No bespoke integration.",
  },
  {
    slug: "cost-accounting-for-agents",
    title: "Cost accounting for agents",
    date: "2026-04-12",
    excerpt: "You need to answer 'what did my agents cost last month'. We built the ledger, budgets, and leaderboard so that question has a single source of truth.",
  },
];

export default function BlogPage() {
  return (
    <div style={{ background: "#0a0a0c", color: "#e8e8ed", minHeight: "100vh", fontFamily: "var(--font-outfit), sans-serif" }}>
      <nav style={{ padding: "16px 32px", borderBottom: "1px solid #2a2a33" }}>
        <Link href="/" style={{ color: "#e8e8ed", textDecoration: "none", fontFamily: "var(--font-outfit), sans-serif", fontWeight: 800 }}>claw<span style={{ color: "#00e5a0" }}>hub</span></Link>
      </nav>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 24px" }}>
        <h1 style={{ fontSize: 48, fontWeight: 800, margin: 0 }}>Blog</h1>
        <p style={{ color: "#8888a0", margin: "8px 0 40px" }}>Notes on building agent-native devtools.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {POSTS.map(p => (
            <article key={p.slug} style={{ borderLeft: "2px solid #2a2a33", paddingLeft: 24 }}>
              <div style={{ fontFamily: "var(--font-jbmono), monospace", fontSize: 12, color: "#8888a0" }}>{new Date(p.date).toLocaleDateString()}</div>
              <h2 style={{ fontSize: 24, fontWeight: 700, margin: "4px 0" }}>{p.title}</h2>
              <p style={{ color: "#c0c0d0" }}>{p.excerpt}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
