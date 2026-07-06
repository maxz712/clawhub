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
 * The shared tab bar: a real <nav> landmark. "More" is DYNAMIC — the bar
 * measures its real estate (ResizeObserver on the strip + a hidden
 * measurement row of every primary tab at natural width) and shows exactly
 * as many primary tabs as fit; the rest fold into More together with the
 * always-More items. `end` tabs stay pinned far-right (inside More on
 * phones). Nothing scrolls, so the strip never grows a scrollbar.
 */
export function TabBar({ items, pathname, ariaLabel, className }: { items: TabItem[]; pathname: string; ariaLabel: string; className?: string }) {
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const primary = items.filter(t => (t.group ?? "primary") === "primary");
  const more = items.filter(t => t.group === "more");
  const end = items.filter(t => t.group === "end");
  const [fit, setFit] = useState(primary.length);

  // Re-measure when the item set changes (counts render wider tabs) or the
  // strip resizes. Measurement reads natural widths off the hidden row.
  const itemsKey = items.map(t => t.key + ":" + (t.count ?? "")).join("|");
  useEffect(() => {
    const strip = stripRef.current, meas = measureRef.current;
    if (!strip || !meas) return;
    const GAP = 4; // Tailwind gap-1
    const recompute = () => {
      const widths = Array.from(meas.children).map(el => (el as HTMLElement).offsetWidth);
      const avail = strip.clientWidth;
      const total = widths.reduce((a, w) => a + w + GAP, 0);
      if (total <= avail) { setFit(widths.length); return; }
      let used = 0, count = 0;
      for (const w of widths) {
        if (used + w + GAP <= avail) { used += w + GAP; count++; } else break;
      }
      setFit(Math.max(1, count));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(strip);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  const visible = primary.slice(0, fit);
  const overflow = primary.slice(fit);
  const menuItems = [...overflow, ...more];

  return (
    <nav aria-label={ariaLabel} className={`border-b flex items-stretch ${className ?? ""}`}>
      <div ref={stripRef} className="relative flex items-stretch gap-1 overflow-hidden flex-1 min-w-0">
        {visible.map(t => <TabLink key={t.key} tab={t} active={isTabItemActive(t, pathname)} />)}
        {/* Hidden measurement row: every primary tab at natural width. */}
        {/* inert: the measurement links must never take keyboard focus (a
            focused invisible link would scroll the clipped strip). */}
        <div ref={measureRef} aria-hidden inert className="absolute left-0 top-0 flex items-stretch gap-1 invisible pointer-events-none">
          {primary.map(t => <TabLink key={t.key} tab={t} active={false} />)}
        </div>
      </div>
      <div className="flex items-stretch shrink-0 pl-1">
        {(menuItems.length > 0 || end.length > 0) && <MoreMenu items={menuItems} mobileExtra={end} pathname={pathname} />}
        {/* `end` tabs pinned far-right on ≥sm; on phones they live inside More. */}
        <div className="hidden sm:flex items-stretch">
          {end.map(t => <TabLink key={t.key} tab={t} active={isTabItemActive(t, pathname)} />)}
        </div>
      </div>
    </nav>
  );
}
