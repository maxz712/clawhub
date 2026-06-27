import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description: "Simple, transparent pricing for solo developers and teams running AI agents on ClawHub. Start free.",
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "Pricing · ClawHub",
    description: "Simple, transparent pricing for solo developers and teams running AI agents on ClawHub. Start free.",
    url: "/pricing",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
