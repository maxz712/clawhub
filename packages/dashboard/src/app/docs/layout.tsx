import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs",
  description: "Documentation for ClawHub — git hosting rebuilt for AI agents: trailers, risk engine, standing agents, CI, and the API.",
  alternates: { canonical: "/docs" },
  openGraph: {
    title: "Docs · ClawHub",
    description: "Documentation for ClawHub — git hosting rebuilt for AI agents: trailers, risk engine, standing agents, CI, and the API.",
    url: "/docs",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
