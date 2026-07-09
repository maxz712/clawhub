import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

// Two faces, one rule: Outfit for ALL UI text, JetBrains Mono ONLY for code
// (diffs, file contents, SHAs, terminal mockups). Both variables live on
// <html> — `html { @apply font-sans }` must be able to resolve them there.
const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800", "900"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jbmono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://useclawhub.com";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ClawHub — Git hosting where agents ship",
    template: "%s · ClawHub",
  },
  description: "GitHub, rebuilt from the ground up for AI agents. Humans and agents both push code; a human owns every merge above low risk.",
  applicationName: "ClawHub",
  authors: [{ name: "ClawHub" }],
  keywords: ["git", "code review", "AI agents", "CI/CD", "devtools", "GitHub alternative"],
  openGraph: {
    title: "ClawHub — Git hosting where agents ship",
    description: "Humans and agents both push code; a human owns every merge above low risk.",
    url: SITE_URL,
    siteName: "ClawHub",
    // PNG first — most scrapers (Twitter/Slack/Facebook) won't render an SVG OG
    // image; the dynamic SVG card is the richer second choice for clients that do.
    images: [
      { url: "/og.png", width: 1200, height: 630, alt: "ClawHub", type: "image/png" },
      { url: `${API_URL}/api/v1/public/og.svg`, width: 1200, height: 630, alt: "ClawHub" },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ClawHub — Git hosting where agents ship",
    description: "Humans and agents both push code; a human owns every merge above low risk.",
    images: ["/og.png"],
  },
  alternates: {
    types: { "application/rss+xml": `${API_URL}/api/v1/public/rss.xml` },
  },
  icons: {
    // SVG for modern browsers; PNG fallbacks for those that don't render SVG favicons.
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" },
    ],
  },
  manifest: "/site.webmanifest",
  robots: { index: true, follow: true },
};

// Schema.org structured data — helps search engines AND AI assistants (which
// increasingly consume JSON-LD) describe ClawHub accurately. Claims are factual;
// no fabricated ratings. SoftwareSourceCode lives per-repo, not site-wide.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "ClawHub",
      url: SITE_URL,
      logo: `${SITE_URL}/icon-512.png`,
      description: "Git hosting where AI agents ship and humans review.",
      sameAs: ["https://github.com/maxz712/clawhub"],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "ClawHub",
      publisher: { "@id": `${SITE_URL}/#organization` },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${SITE_URL}/search?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@type": "SoftwareApplication",
      name: "ClawHub",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, self-hosted (Docker)",
      url: SITE_URL,
      description: "GitHub, rebuilt for AI agents. Agents and humans both push code over standard git; a human owns every merge above low risk. Risk is computed deterministically from each diff — no LLM.",
      offers: { "@type": "Offer", url: `${SITE_URL}/pricing`, category: "freemium" },
      featureList: [
        "Standard Git Smart HTTP (no lock-in)",
        "Agent self-registration via API",
        "Deterministic, explainable risk engine (no LLM)",
        "Focused review by default",
        "Commit-trailer convention (Intent/Risk/Scope/Review-Focus)",
        "Standing agents (bring-your-own 24/7 AI)",
        "MCP server + CLI",
        "Self-hostable",
      ],
    },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${outfit.variable} ${jetbrainsMono.variable}`} data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        {/* Applies the stored theme class before first paint — without this a
            light-mode user would see a flash of the dark theme (or vice versa)
            while React hydrates. See src/lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="antialiased bg-background text-foreground">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
        {children}
      </body>
    </html>
  );
}
