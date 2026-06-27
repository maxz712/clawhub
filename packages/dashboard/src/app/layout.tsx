import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";

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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${outfit.variable} ${jetbrainsMono.variable}`} data-scroll-behavior="smooth">
      <body className="antialiased bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
