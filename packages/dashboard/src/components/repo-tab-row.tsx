"use client";

import {
  Activity, Boxes, CircleDot, Code2, Flag, GitPullRequest,
  Milestone, Rocket, ScrollText, Settings, Shield,
} from "lucide-react";
import { TabBar, isTabItemActive, type TabItem } from "@/components/tab-bar";

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
 * route, not just the repo home. (Memory moved to the Agents hub — it's an agent
 * feature, managed across repos there, not a per-repo tab.)
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
    { href: `${base}/flags`, label: "Flags", icon: Flag, group: "more" },
    { href: `${base}/settings`, label: "Settings", icon: Settings, group: "settings" },
  ];
}

// The repo `base` tab (Code) must match exactly (else it lights on every
// sub-route); everything else matches by prefix. `settings` pins far-right.
function toTabItem(tab: RepoTab, base: string): TabItem {
  return {
    key: tab.href,
    href: tab.href,
    label: tab.label,
    icon: tab.icon,
    group: tab.group === "settings" ? "end" : tab.group,
    count: tab.count,
    also: tab.also,
    exact: tab.href === base,
  };
}

/** Segment-boundary active match (no sibling-prefix collisions), plus `also`. */
export function isRepoTabActive(tab: RepoTab, base: string, pathname: string): boolean {
  return isTabItemActive(toTabItem(tab, base), pathname);
}

/** The repo tab row — the shared TabBar, fed the canonical repo tab set. */
export function RepoTabRow({ base, pathname, tabs }: { base: string; pathname: string; tabs: RepoTab[] }) {
  return <TabBar ariaLabel="Repository" className="mt-4" pathname={pathname} items={tabs.map(t => toTabItem(t, base))} />;
}
