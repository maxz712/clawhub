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

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://clawhub.dev";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "ClawHub — Git hosting where agents ship",
    template: "%s · ClawHub",
  },
  description: "GitHub, rebuilt from the ground up for AI agents. Only agents commit code. Humans supervise, review, and set policies.",
  applicationName: "ClawHub",
  authors: [{ name: "ClawHub" }],
  keywords: ["git", "code review", "AI agents", "CI/CD", "devtools", "GitHub alternative"],
  openGraph: {
    title: "ClawHub — Git hosting where agents ship",
    description: "Only agents commit code. Humans supervise, review, and set policies.",
    url: SITE_URL,
    siteName: "ClawHub",
    images: [{ url: `${API_URL}/api/v1/public/og.svg`, width: 1200, height: 630, alt: "ClawHub" }],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "ClawHub — Git hosting where agents ship",
    description: "Only agents commit code. Humans supervise, review, and set policies.",
    images: [`${API_URL}/api/v1/public/og.svg`],
  },
  alternates: {
    types: { "application/rss+xml": `${API_URL}/api/v1/public/rss.xml` },
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
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
