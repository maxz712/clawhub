"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, MoreHorizontal } from "lucide-react";

type Icon = typeof MoreHorizontal;

// One shared tab bar for every horizontal-tab surface (repo tabs, the Agents
// hub, …) so they look + behave identically: a scrollable strip of `primary`
// tabs, the long tail behind a pinned "More" dropdown, optional `end` tabs
// pinned far-right (e.g. repo Settings), the active tab scrolled into view, and
// — crucially — the bar never just runs off the edge.
export type TabItem = {
  key: string;
  href: string;
  label: string;
  icon: Icon;
  /** primary = always-visible strip; more = behind "More"; end = pinned right. Default primary. */
  group?: "primary" | "more" | "end";
  count?: number;
  /** Extra path prefixes that should also light this tab. */
  also?: string[];
  /** Match only the exact href (+ `also`), not descendants — for a section-root tab like /agents. */
  exact?: boolean;
};

export function isTabItemActive(tab: TabItem, pathname: string): boolean {
  const matches = (h: string) => pathname === h || pathname.startsWith(h + "/");
  if (tab.exact) return pathname === tab.href || (tab.also ?? []).some(matches);
  return matches(tab.href) || (tab.also ?? []).some(matches);
}

const tabClass = (active: boolean) =>
  `inline-flex items-center gap-1.5 px-3 min-h-11 text-sm border-b-2 -mb-px whitespace-nowrap ${
    active
      ? "border-primary text-foreground font-medium"
      : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
  }`;

function TabLink({ tab, active }: { tab: TabItem; active: boolean }) {
  const Icon = tab.icon;
  return (
    <Link href={tab.href} data-active={active || undefined} aria-current={active ? "page" : undefined} className={tabClass(active)}>
      <Icon className="h-4 w-4" /> {tab.label}
      {typeof tab.count === "number" && <span className="text-xs rounded-full bg-muted px-1.5">{tab.count}</span>}
    </Link>
  );
}

function MoreMenu({ items, mobileExtra = [], pathname }: { items: TabItem[]; mobileExtra?: TabItem[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = [...items, ...mobileExtra].some(t => isTabItemActive(t, pathname));

  // Close on navigation so the menu never lingers across a route change.
  useEffect(() => { setOpen(false); }, [pathname]);
  // Dismiss on outside-click / Escape — hand-rolled menu (no dropdown primitive
  // ships in this app); aria-expanded + Escape/outside-click is the contract.
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
        <div className="absolute right-0 top-full z-30 mt-1 min-w-48 rounded-md border bg-card shadow-lg py-1">
          {items.map(t => {
            const a = isTabItemActive(t, pathname);
            const Icon = t.icon;
            return (
              <Link key={t.key} href={t.href} aria-current={a ? "page" : undefined}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${a ? "text-foreground font-medium bg-accent/40" : "text-muted-foreground"} hover:bg-accent hover:text-foreground`}>
                <Icon className="h-4 w-4" /> {t.label}
                {typeof t.count === "number" && <span className="ml-auto text-xs rounded-full bg-muted px-1.5">{t.count}</span>}
              </Link>
            );
          })}
          {/* On phones, the pinned `end` tabs fold in here (they're pinned far-
              right on ≥sm) so the scroll strip has room for full labels. */}
          {mobileExtra.map(t => {
            const a = isTabItemActive(t, pathname);
            const Icon = t.icon;
            return (
              <Link key={t.key} href={t.href} aria-current={a ? "page" : undefined}
                className={`sm:hidden flex items-center gap-2 px-3 py-2 text-sm border-t mt-1 pt-2 ${a ? "text-foreground font-medium bg-accent/40" : "text-muted-foreground"} hover:bg-accent hover:text-foreground`}>
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
 * The shared tab bar: a real <nav> landmark with primary tabs in a horizontally
 * scrollable strip, the long tail behind a pinned "More" dropdown, and `end`
 * tabs pinned far-right — so More + end stay reachable even when the primary
 * tabs overflow on a phone. The active tab is scrolled into view on navigation.
 */
export function TabBar({ items, pathname, ariaLabel, className }: { items: TabItem[]; pathname: string; ariaLabel: string; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const primary = items.filter(t => (t.group ?? "primary") === "primary");
  const more = items.filter(t => t.group === "more");
  const end = items.filter(t => t.group === "end");

  // Bring the active tab into view inside the scroll strip (mobile) without
  // scrolling the rest of the page — adjust the strip's scrollLeft only.
  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    const el = c.querySelector("[data-active]") as HTMLElement | null;
    if (!el) return;
    if (el.offsetLeft < c.scrollLeft || el.offsetLeft + el.offsetWidth > c.scrollLeft + c.clientWidth) {
      c.scrollTo({ left: Math.max(0, el.offsetLeft - 16) });
    }
  }, [pathname]);

  return (
    <nav aria-label={ariaLabel} className={`border-b flex items-stretch ${className ?? ""}`}>
      <div ref={scrollRef} className="relative flex items-stretch gap-1 overflow-x-auto flex-1 min-w-0" style={{ scrollbarWidth: "none" }}>
        {primary.map(t => <TabLink key={t.key} tab={t} active={isTabItemActive(t, pathname)} />)}
      </div>
      <div className="flex items-stretch shrink-0 pl-1">
        {(more.length > 0 || end.length > 0) && <MoreMenu items={more} mobileExtra={end} pathname={pathname} />}
        {/* `end` tabs pinned far-right on ≥sm; on phones they live inside More. */}
        <div className="hidden sm:flex items-stretch">
          {end.map(t => <TabLink key={t.key} tab={t} active={isTabItemActive(t, pathname)} />)}
        </div>
      </div>
    </nav>
  );
}
