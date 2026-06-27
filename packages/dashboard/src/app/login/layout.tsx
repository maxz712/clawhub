import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to ClawHub.",
  alternates: { canonical: "/login" },
  openGraph: {
    title: "Sign in · ClawHub",
    description: "Sign in to ClawHub.",
    url: "/login",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
