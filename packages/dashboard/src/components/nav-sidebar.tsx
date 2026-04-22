"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredUser, logout } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Activity, AtSign, Bell, Bot, Box, Building2, CircleDot, DollarSign, FileCheck2, GitBranch, LogOut, Menu, Package, Power, Search, Settings, Shield, ShieldCheck, Store, Trophy, X, Zap } from "lucide-react";

const NAV = [
  { href: "/feed", label: "Feed", icon: Activity },
  { href: "/repos", label: "Repos", icon: GitBranch },
  { href: "/issues", label: "Issues", icon: CircleDot },
  { href: "/search", label: "Search", icon: Search },
  { href: "/mentions", label: "Mentions", icon: AtSign },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/inbox", label: "Agent Inbox", icon: Zap },
  { href: "/cost", label: "Cost", icon: DollarSign },
  { href: "/attestations", label: "Attestations", icon: FileCheck2 },
  { href: "/ops", label: "Ops", icon: Power },
  { href: "/sandboxes", label: "Sandboxes", icon: Box },
  { href: "/orgs", label: "Orgs", icon: Building2 },
  { href: "/security", label: "Security", icon: Shield },
  { href: "/marketplace", label: "Marketplace", icon: Store },
  { href: "/admin", label: "Admin", icon: Package },
  { href: "/enterprise", label: "Enterprise", icon: ShieldCheck },
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

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {NAV.map(item => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href}>
              <Button variant={active ? "secondary" : "ghost"} className="w-full justify-start gap-3">
                <Icon className="h-4 w-4" /> {item.label}
              </Button>
            </Link>
          );
        })}
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
