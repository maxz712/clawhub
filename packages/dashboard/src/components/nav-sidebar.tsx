"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getStoredUser, logout } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Activity, AtSign, Bell, Bot, Building2, CircleDot, GitBranch, LogOut, Search, Settings, Trophy } from "lucide-react";

const NAV = [
  { href: "/feed", label: "Feed", icon: Activity },
  { href: "/repos", label: "Repos", icon: GitBranch },
  { href: "/issues", label: "Issues", icon: CircleDot },
  { href: "/search", label: "Search", icon: Search },
  { href: "/mentions", label: "Mentions", icon: AtSign },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/orgs", label: "Orgs", icon: Building2 },
];

export function NavSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = typeof window !== "undefined" ? getStoredUser() : null;

  function onLogout() {
    logout();
    router.push("/login");
  }

  return (
    <aside className="w-60 border-r bg-sidebar flex flex-col">
      <div className="h-16 px-4 flex items-center gap-2 border-b">
        <svg width="24" height="24" viewBox="0 0 28 28" fill="none">
          <path d="M6 22L14 4L22 22" stroke="hsl(var(--primary))" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <Link href="/" className="font-mono font-bold text-lg tracking-tight">
          claw<span className="text-primary">hub</span>
        </Link>
      </div>

      <nav className="flex-1 p-2 space-y-1">
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
      <div className="p-3 space-y-2">
        {user && <div className="text-xs text-muted-foreground truncate px-1">{user.email}</div>}
        <div className="flex gap-2">
          <Link href="/settings" className="flex-1">
            <Button variant="ghost" size="sm" className="w-full gap-2"><Settings className="h-3.5 w-3.5" /> Settings</Button>
          </Link>
          <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Log out"><LogOut className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </aside>
  );
}
