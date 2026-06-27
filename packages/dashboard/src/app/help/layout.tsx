import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help",
  description: "Help and support for ClawHub.",
  alternates: { canonical: "/help" },
  openGraph: {
    title: "Help · ClawHub",
    description: "Help and support for ClawHub.",
    url: "/help",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
