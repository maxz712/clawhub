"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isLoggedIn } from "@/lib/auth";
import { NavSidebar } from "@/components/nav-sidebar";
import { TermsReacceptBanner } from "@/components/terms-reaccept-banner";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoggedIn()) {
      // Preserve the visitor's destination so /login can send them back after
      // auth (public pages link into /repos/<ns>/<repo> under this group). Only
      // the internal path+query is forwarded — never an absolute/external URL.
      const dest = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
      router.replace(dest ? `/login?next=${encodeURIComponent(dest)}` : "/login");
    } else setReady(true);
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <NavSidebar />
      <main className="flex-1 overflow-auto pt-14 md:pt-0 min-w-0">
        <TermsReacceptBanner />
        <div className="max-w-6xl mx-auto p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
