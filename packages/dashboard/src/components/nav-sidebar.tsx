"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredUser, isLoggedIn, logout } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Activity, AtSign, Bell, Bot, Box, Boxes, Building2, ChevronDown, ChevronUp, CircleDot, DollarSign, Download, FileCheck2, GitBranch, LogOut, Menu, Package, Power, Search, Settings, Shield, Store, Users, X, Zap } from "lucide-react";

type NavItem = { href: string; label: string; icon: typeof Activity };
type NavGroup = { title: string | null; items: NavItem[] };

// Core triage — what every supervisor uses daily. Always visible.
const CORE_GROUPS: NavGroup[] = [
  { title: null, items: [
    { href: "/feed", label: "Home", icon: Activity },
    { href: "/repos", label: "Repos", icon: GitBranch },
    // Import sits next to Repos so a user bringing an existing GitHub/GitLab/
    // Bitbucket repo finds it on the first screen — onboarding, not a buried
    // platform tool.
    { href: "/import", label: "Import", icon: Download },
    { href: "/search", label: "Search", icon: Search },
    { href: "/notifications", label: "Notifications", icon: Bell },
    { href: "/mentions", label: "Mentions", icon: AtSign },
  ]},
  { title: "Agents", items: [
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/roles", label: "Roles", icon: Boxes },
    { href: "/issues", label: "Issues", icon: CircleDot },
  ]},
];

// Advanced / platform surfaces (fleet ops + Admin/Enterprise/Marketplace/…).
// Collapsed behind a "More" disclosure for every solo user — not part of the
// day-to-day review loop, so they never auto-expand.
const ADVANCED_GROUPS: NavGroup[] = [
  { title: "Agent fleet", items: [
    { href: "/inbox", label: "Agent inbox", icon: Zap },
    { href: "/cost", label: "Cost", icon: DollarSign },
    { href: "/attestations", label: "Attestations", icon: FileCheck2 },
    { href: "/sandboxes", label: "Sandboxes", icon: Box },
  ]},
  { title: "Platform", items: [
    { href: "/orgs", label: "Orgs", icon: Building2 },
    { href: "/security", label: "Security", icon: Shield },
    { href: "/marketplace", label: "Marketplace", icon: Store },
    { href: "/ops", label: "Ops", icon: Power },
    // Admin is operator-only — filtered out below unless the caller is a
    // platform admin. (Enterprise is marketing/upsell; it lives on the public
    // site + /pricing, not a workspace nav entry.)
    { href: "/admin", label: "Admin", icon: Package },
  ]},
];

export function NavSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = typeof window !== "undefined" ? getStoredUser() : null;
  const [open, setOpen] = useState(false);
  // Advanced/platform surfaces (Admin, Enterprise, Ops, Marketplace, Sandboxes,
  // Attestations, …) collapse behind a "More" disclosure that stays COLLAPSED by
  // default — a solo dev's day-to-day loop is Home/Repos/Issues/Agents. Having a
  // repo or agent doesn't make these relevant, so we no longer auto-expand: the
  // user opts in by clicking "More" (and we keep it open while they're on one of
  // those routes).
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The org Fleet is org-scoped (`/orgs/:id/fleet`), so its destination depends
  // on how many orgs the user belongs to. We resolve a single target here so
  // "Fleet" is a first-class nav entry instead of being buried under an org
  // sub-tab: 1 org → that org's fleet; >1 → the org picker (each org links on to
  // its fleet); 0 orgs → omit it entirely (a solo user has no org fleet).
  const [fleetHref, setFleetHref] = useState<string | null>(null);
  // Unread in-app notifications — drives the badge on the Bell. Polled (60s) and
  // re-fetched on navigation so marking items read on the inbox updates it.
  const [unread, setUnread] = useState(0);
  // Platform-admin status (CLAWHUB_ADMIN_EMAILS) — gates the Admin nav entry so a
  // regular user never sees an operators-only console they'd 403 on.
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined" || !isLoggedIn()) return;
    let cancelled = false;
    const tick = () => api.unreadNotificationCount().then(r => { if (!cancelled) setUnread(r.count); }).catch(() => {});
    void tick();
    const h = setInterval(tick, 60_000);
    // The inbox dispatches this when the user marks notifications read, so the
    // badge updates immediately instead of waiting for the next 60s poll.
    window.addEventListener("clawhub:notifications-changed", tick);
    return () => { cancelled = true; clearInterval(h); window.removeEventListener("clawhub:notifications-changed", tick); };
  }, [pathname]);

  useEffect(() => {
    if (typeof window === "undefined" || !isLoggedIn()) return;
    let cancelled = false;
    api.listOrgs()
      .then(r => {
        if (cancelled) return;
        if (r.orgs.length === 1) setFleetHref(`/orgs/${r.orgs[0].id}/fleet`);
        else if (r.orgs.length > 1) setFleetHref("/orgs");
        else setFleetHref(null);
      })
      .catch(() => { /* leave Fleet hidden if we can't resolve orgs */ });
    api.getAdminStatus()
      .then(r => { if (!cancelled) setIsAdmin(r.isAdmin); })
      .catch(() => { /* not an admin / not reachable — keep Admin hidden */ });
    return () => { cancelled = true; };
  }, []);

  // Inject "Fleet" into the "Agent fleet" group when the user has an org to
  // point it at. Built from the static groups so the collapse behavior below is
  // unchanged — it still lives under "More" and only auto-expands on an advanced
  // route.
  const advancedGroups: NavGroup[] = ADVANCED_GROUPS.map(g => {
    let items = g.title === "Agent fleet" && fleetHref
      ? [{ href: fleetHref, label: "Fleet", icon: Users }, ...g.items]
      : g.items;
    // Admin is platform-operator only — hide it for everyone else.
    if (!isAdmin) items = items.filter(i => i.href !== "/admin");
    return { ...g, items };
  });

  // Auto-expand the advanced section when the user lands on one of its routes so
  // the active item is visible — but they keep full control via the More/Less
  // toggle below. (Previously `More` was a one-way reveal with no way to collapse
  // again; now it's a real toggle and landing on an advanced route just opens it.)
  const onAdvancedRoute = advancedGroups.some(g => g.items.some(i => pathname === i.href || pathname.startsWith(i.href + "/")));
  useEffect(() => { if (onAdvancedRoute) setShowAdvanced(true); }, [onAdvancedRoute]);

  function onLogout() {
    logout();
    router.push("/login");
  }

  function renderGroup(group: NavGroup) {
    return (
      <div key={group.title ?? "main"} className="space-y-0.5">
        {group.title && (
          <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">{group.title}</div>
        )}
        {group.items.map(item => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          const showBadge = item.href === "/notifications" && unread > 0;
          return (
            <Link key={item.href} href={item.href}>
              <Button variant={active ? "secondary" : "ghost"} size="sm" className="w-full justify-start gap-3">
                <Icon className="h-4 w-4" /> {item.label}
                {showBadge && (
                  <span className="ml-auto inline-flex min-w-5 h-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Button>
            </Link>
          );
        })}
      </div>
    );
  }

  const navBody = (
    <>
      <div className="h-16 px-4 flex items-center gap-2 border-b shrink-0">
        <svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <g stroke="hsl(var(--primary))" className="stroke-primary" strokeWidth="2.6" strokeLinecap="round">
            <path d="M15.5 4L5 15.5" />
            <path d="M19 6.5L8.5 18.5" />
            <path d="M22.5 9.5L12 21.5" />
          </g>
        </svg>
        <Link href="/" className="font-bold text-lg tracking-tight">
          claw<span className="text-primary">hub</span>
        </Link>
        <button className="md:hidden ml-auto" onClick={() => setOpen(false)} aria-label="Close menu">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Thin, subtle scrollbar (inline so it survives the CSS pipeline) — an
          occasional overflow when "More" is expanded reads as intentional
          instead of a jarring default chunky bar. */}
      <nav className="flex-1 p-2 space-y-4 overflow-y-auto" style={{ scrollbarWidth: "thin", scrollbarColor: "var(--border) transparent" }}>
        {CORE_GROUPS.map(group => renderGroup(group))}

        {showAdvanced && advancedGroups.map(group => renderGroup(group))}

        {/* A real two-way toggle: reveals the advanced groups, and is always
            present so the user can collapse them again. */}
        <button
          onClick={() => setShowAdvanced(v => !v)}
          aria-expanded={showAdvanced}
          className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-accent transition-colors"
        >
          {showAdvanced ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />} {showAdvanced ? "Less" : "More"}
        </button>
      </nav>

      <Separator />
      <div className="p-3 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 shrink-0 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-semibold uppercase">
            {(user?.name ?? user?.email ?? "?").charAt(0)}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            {user?.name && <div className="text-sm font-medium truncate">{user.name}</div>}
            <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
          </div>
          <Link href="/settings">
            <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings"><Settings className="h-4 w-4" /></Button>
          </Link>
          <Button variant="ghost" size="icon-sm" onClick={onLogout} aria-label="Log out" title="Log out"><LogOut className="h-4 w-4" /></Button>
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
        <Link href="/" className="font-bold">claw<span className="text-primary">hub</span></Link>
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
