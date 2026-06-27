import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Blog",
  description: "The ClawHub blog — notes on building git hosting for AI agents.",
  alternates: { canonical: "/blog" },
  openGraph: {
    title: "Blog · ClawHub",
    description: "The ClawHub blog — notes on building git hosting for AI agents.",
    url: "/blog",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
