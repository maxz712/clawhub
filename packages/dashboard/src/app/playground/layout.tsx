import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Diff playground",
  description: "Paste a diff and watch ClawHub's focused review + commit-trailer parsing in action — no account needed.",
  alternates: { canonical: "/playground" },
  openGraph: {
    title: "Diff playground · ClawHub",
    description: "Paste a diff and watch ClawHub's focused review + commit-trailer parsing in action — no account needed.",
    url: "/playground",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
