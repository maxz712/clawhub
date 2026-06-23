"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Activity, Boxes, Brain, ChevronDown, CircleDot, Code2, Flag, GitPullRequest,
  Milestone, MoreHorizontal, Rocket, ScrollText, Settings, Shield,
} from "lucide-react";

type Icon = typeof Activity;

export type RepoTab = {
  href: string;
  label: string;
  icon: Icon;
  /** primary = always-visible inline; more = behind the "More" dropdown; settings = right-aligned. */
  group: "primary" | "more" | "settings";
  count?: number;
  /** Extra path prefixes that should light THIS tab (e.g. proposals → Changes). */
  also?: string[];
  /** Surfaced on the logged-out public mirror (Code/Changes/Issues only). */
  public?: boolean;
};

/**
 * Canonical repo tab set, ordered by supervisor frequency. One source of truth
 * for both the authenticated RepoHeader and the public mirror — `base` is the
 * repo root (`/repos/<ns>/<repo>` or `/r/<ns>/<repo>`), so the same definitions
 * target either surface. Counts persist because the layout passes them on every
 * route, not just the repo home.
 */
export function buildRepoTabs(base: string, counts?: { changes?: number; issues?: number }): RepoTab[] {
  return [
    { href: base, label: "Code", icon: Code2, group: "primary", public: true, also: [`${base}/tree`, `${base}/blob`] },
    // Cross-repo proposals live under the repo but have no tab of their own —
    // fold them into Changes so /proposals lights the Changes tab + has a path back.
    { href: `${base}/changes`, label: "Changes", icon: GitPullRequest, group: "primary", public: true, count: counts?.changes, also: [`${base}/proposals`] },
    { href: `${base}/issues`, label: "Issues", icon: CircleDot, group: "primary", public: true, count: counts?.issues },
    { href: `${base}/security`, label: "Security", icon: Shield, group: "primary" },
    { href: `${base}/releases`, label: "Releases", icon: Rocket, group: "primary" },
    { href: `${base}/packages`, label: "Packages", icon: Boxes, group: "more" },
    { href: `${base}/milestones`, label: "Milestones", icon: Milestone, group: "more" },
    { href: `${base}/activity`, label: "Activity", icon: Activity, group: "more" },
    { href: `${base}/audit`, label: "Audit", icon: ScrollText, group: "more" },
    { href: `${base}/memory`, label: "Memory", icon: Brain, group: "more" },
    { href: `${base}/flags`, label: "Flags", icon: Flag, group: "more" },
    { href: `${base}/settings`, label: "Settings", icon: Settings, group: "settings" },
  ];
}

/** Segment-boundary active match (no sibling-prefix collisions), plus `also`. */
export function isRepoTabActive(tab: RepoTab, base: string, pathname: string): boolean {
  const matches = (h: string) => pathname === h || pathname.startsWith(h + "/");
  // The Code/home tab is `base` itself — `startsWith(base + "/")` would match
  // every sub-route, so it's active only on the root or an `also` prefix.
  if (tab.href === base) {
    return pathname === base || (tab.also ?? []).some(matches);
  }
  return matches(tab.href) || (tab.also ?? []).some(matches);
}

const tabClass = (active: boolean) =>
  `inline-flex items-center gap-1.5 px-3 min-h-11 text-sm border-b-2 -mb-px whitespace-nowrap ${
    active
      ? "border-primary text-foreground font-medium"
      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
  }`;

function TabLink({ tab, active }: { tab: RepoTab; active: boolean }) {
  const Icon = tab.icon;
  return (
    <Link href={tab.href} data-active={active || undefined} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <Icon className="h-4 w-4" /> {tab.label}
      {typeof tab.count === "number" && <span className="text-xs rounded-full bg-muted px-1.5">{tab.count}</span>}
    </Link>
  );
}

function MoreMenu({ items, base, pathname }: { items: RepoTab[]; base: string; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = items.some(t => isRepoTabActive(t, base, pathname));

  // Close on navigation so the menu never lingers across a route change.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Dismiss on outside-click / Escape — this is a hand-rolled menu (no Base UI
  // dropdown primitive ships in this app).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-stretch">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        data-active={active || undefined} className={tabClass(active)}>
        <MoreHorizontal className="h-4 w-4" /> More
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        // A disclosure of plain links (not an ARIA menu/menuitem — we don't wire
        // the roving-focus keyboard model that role implies); aria-expanded above
        // + Escape/outside-click below is the honest contract.
        <div className="absolute right-0 top-full z-30 mt-1 min-w-48 rounded-md border bg-card shadow-lg py-1">
          {items.map(t => {
            const a = isRepoTabActive(t, base, pathname);
            const Icon = t.icon;
            return (
              <Link key={t.href} href={t.href} aria-current={a ? "page" : undefined}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${a ? "text-foreground font-medium bg-accent/40" : "text-muted-foreground"} hover:bg-accent hover:text-foreground`}>
                <Icon className="h-4 w-4" /> {t.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The repo tab row: a real <nav> landmark with primary tabs in a horizontally
 * scrollable strip, the long tail behind a pinned "More" dropdown, and Settings
 * pinned far-right — so More + Settings stay reachable even when the primary
 * tabs overflow on a phone. Active tab is scrolled into view on navigation.
 */
export function RepoTabRow({ base, pathname, tabs }: { base: string; pathname: string; tabs: RepoTab[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const primary = tabs.filter(t => t.group === "primary");
  const more = tabs.filter(t => t.group === "more");
  const settings = tabs.filter(t => t.group === "settings");

  // Bring the active tab into view inside the scroll strip (mobile) without
  // scrolling the rest of the page — adjust the strip's scrollLeft only.
  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    const el = c.querySelector('[data-active]') as HTMLElement | null;
    if (!el) return;
    if (el.offsetLeft < c.scrollLeft || el.offsetLeft + el.offsetWidth > c.scrollLeft + c.clientWidth) {
      c.scrollTo({ left: Math.max(0, el.offsetLeft - 16) });
    }
  }, [pathname]);

  return (
    <nav aria-label="Repository" className="mt-4 border-b flex items-stretch">
      {/* Horizontally scrollable on overflow, but with NO visible scrollbar:
          `overflow-x-auto` alone forces overflow-y to `auto` too (CSS spec), and
          the horizontal bar then steals height → a pointless phantom vertical
          scrollbar. Hiding the scrollbar removes both; the active tab is still
          scrolled into view by the effect above. */}
      <div ref={scrollRef} className="relative flex items-stretch gap-1 overflow-x-auto flex-1 min-w-0" style={{ scrollbarWidth: "none" }}>
        {primary.map(t => <TabLink key={t.href} tab={t} active={isRepoTabActive(t, base, pathname)} />)}
      </div>
      <div className="flex items-stretch shrink-0 pl-1">
        {more.length > 0 && <MoreMenu items={more} base={base} pathname={pathname} />}
        {settings.map(t => <TabLink key={t.href} tab={t} active={isRepoTabActive(t, base, pathname)} />)}
      </div>
    </nav>
  );
}
