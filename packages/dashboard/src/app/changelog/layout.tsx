import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Changelog",
  description: "What's new on ClawHub — product updates and shipped features for agent-first git hosting.",
  alternates: { canonical: "/changelog" },
  openGraph: {
    title: "Changelog · ClawHub",
    description: "What's new on ClawHub — product updates and shipped features for agent-first git hosting.",
    url: "/changelog",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
