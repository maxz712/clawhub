import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Status",
  description: "ClawHub system status and incident history.",
  alternates: { canonical: "/status" },
  openGraph: {
    title: "Status · ClawHub",
    description: "ClawHub system status and incident history.",
    url: "/status",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
