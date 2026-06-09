"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredUser, logout } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Activity, AtSign, Bell, Bot, Box, Building2, CircleDot, DollarSign, FileCheck2, GitBranch, LogOut, Menu, Package, Power, Search, Settings, Shield, ShieldCheck, Store, Trophy, X, Zap } from "lucide-react";

// Grouped by what supervisors actually do: daily triage first, then managing
// the agent fleet, then platform/admin surfaces they visit occasionally.
const NAV_GROUPS: Array<{ title: string | null; items: Array<{ href: string; label: string; icon: typeof Activity }> }> = [
  { title: null, items: [
    { href: "/feed", label: "Home", icon: Activity },
    { href: "/repos", label: "Repos", icon: GitBranch },
    { href: "/issues", label: "Issues", icon: CircleDot },
    { href: "/search", label: "Search", icon: Search },
    { href: "/notifications", label: "Notifications", icon: Bell },
    { href: "/mentions", label: "Mentions", icon: AtSign },
  ]},
  { title: "Agents", items: [
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/inbox", label: "Agent inbox", icon: Zap },
    { href: "/cost", label: "Cost", icon: DollarSign },
    { href: "/attestations", label: "Attestations", icon: FileCheck2 },
    { href: "/sandboxes", label: "Sandboxes", icon: Box },
    { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  ]},
  { title: "Platform", items: [
    { href: "/orgs", label: "Orgs", icon: Building2 },
    { href: "/security", label: "Security", icon: Shield },
    { href: "/marketplace", label: "Marketplace", icon: Store },
    { href: "/ops", label: "Ops", icon: Power },
    { href: "/enterprise", label: "Enterprise", icon: ShieldCheck },
    { href: "/admin", label: "Admin", icon: Package },
  ]},
];

export function NavSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = typeof window !== "undefined" ? getStoredUser() : null;
  const [open, setOpen] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);

  function onLogout() {
    logout();
    router.push("/login");
  }

  const navBody = (
    <>
      <div className="h-16 px-4 flex items-center gap-2 border-b shrink-0">
        <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
          <path d="M6 22L14 4L22 22" stroke="hsl(var(--primary))" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <Link href="/" className="font-mono font-bold text-lg tracking-tight">
          claw<span className="text-primary">hub</span>
        </Link>
        <button className="md:hidden ml-auto" onClick={() => setOpen(false)} aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 p-2 space-y-4 overflow-y-auto">
        {NAV_GROUPS.map(group => (
          <div key={group.title ?? "main"} className="space-y-0.5">
            {group.title && (
              <div className="px-3 pb-1 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/70">{group.title}</div>
            )}
            {group.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <Button variant={active ? "secondary" : "ghost"} size="sm" className="w-full justify-start gap-3 font-mono text-[13px]">
                    <Icon className="h-4 w-4" /> {item.label}
                  </Button>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <Separator />
      <div className="p-3 space-y-2 shrink-0">
        {user && <div className="text-xs text-muted-foreground truncate px-1">{user.email}</div>}
        <div className="flex gap-2">
          <Link href="/settings" className="flex-1">
            <Button variant="ghost" size="sm" className="w-full gap-2"><Settings className="h-3.5 w-3.5" /> Settings</Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Log out"><LogOut className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-14 border-b bg-background z-40 flex items-center justify-between px-4">
        <button onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <Link href="/" className="font-mono font-bold">claw<span className="text-primary">hub</span></Link>
        <div className="w-5" />
      </div>

      {/* Desktop static sidebar */}
      <aside className="hidden md:flex w-60 border-r bg-sidebar flex-col sticky top-0 h-screen">
        {navBody}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <>
          <div className="md:hidden fixed inset-0 bg-black/60 z-40" onClick={() => setOpen(false)} />
          <aside className="md:hidden fixed top-0 left-0 bottom-0 w-64 border-r bg-sidebar flex flex-col z-50">
            {navBody}
          </aside>
        </>
      )}
    </>
  );
}
