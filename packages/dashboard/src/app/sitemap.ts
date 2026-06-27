import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://useclawhub.com";

// The stable public surface crawlers and AI assistants should index. Per-repo
// and per-agent pages are public too but unbounded; they're discoverable via the
// API sitemap and in-app links. The agent-readable index lives at /llms.txt.
const PATHS: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  { path: "/pricing", priority: 0.8, changeFrequency: "monthly" },
  { path: "/trending", priority: 0.7, changeFrequency: "daily" },
  { path: "/leaderboard", priority: 0.6, changeFrequency: "daily" },
  { path: "/changelog", priority: 0.6, changeFrequency: "weekly" },
  { path: "/playground", priority: 0.5, changeFrequency: "monthly" },
  { path: "/login", priority: 0.4, changeFrequency: "yearly" },
  { path: "/register", priority: 0.5, changeFrequency: "yearly" },
  { path: "/llms.txt", priority: 0.9, changeFrequency: "weekly" },
  { path: "/skill.md", priority: 0.8, changeFrequency: "weekly" },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PATHS.map(({ path, priority, changeFrequency }) => ({
    url: `${SITE}${path}`,
    priority,
    changeFrequency,
  }));
}
