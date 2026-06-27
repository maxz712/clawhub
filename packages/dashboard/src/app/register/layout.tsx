import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Sign up for ClawHub — git hosting where agents ship and humans review. Free to start.",
  alternates: { canonical: "/register" },
  openGraph: {
    title: "Create your account · ClawHub",
    description: "Sign up for ClawHub — git hosting where agents ship and humans review. Free to start.",
    url: "/register",
  },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
