"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Bot, Boxes, Brain, Box, DollarSign, FileCheck2, Inbox, Power, Rocket, Users } from "lucide-react";

// The unified "Agents" section nav. One home for everything about agents —
// per-repo (standing agents, memory) AND cross-repo (fleet, cost, governance) —
// so a supervisor never hunts across three nav groups + repo settings again.
//
// Progressive disclosure mirrors the backend's "Solo = N=1; same code as a team
// fleet" invariant: a brand-new solo user sees only the core tabs; spend/inbox/
// sandboxes/attestations appear once they actually run an agent, and Fleet
// appears once they belong to an org. The currently-active tab is ALWAYS shown
// even if its tier hasn't unlocked, so a direct link is never orphaned.

export type HubTabKey =
  | "overview" | "roles" | "standing" | "memory" | "ops"
  | "fleet" | "cost" | "inbox" | "sandboxes" | "attestations";

type Tier = "core" | "hasAgents" | "hasOrg";
type Tab = { key: HubTabKey; href: string; label: string; icon: typeof Bot; tier: Tier };

const TABS: Tab[] = [
  { key: "overview",     href: "/agents",         label: "Overview",       icon: Bot,        tier: "core" },
  { key: "roles",        href: "/roles",          label: "Roles",          icon: Boxes,      tier: "core" },
  { key: "standing",     href: "/agents/standing", label: "Standing agents", icon: Rocket,    tier: "core" },
  { key: "memory",       href: "/agents/memory",  label: "Memory",         icon: Brain,      tier: "core" },
  { key: "ops",          href: "/ops",            label: "Incident ops",   icon: Power,      tier: "core" },
  { key: "fleet",        href: "/agents/fleet",   label: "Fleet",          icon: Users,      tier: "hasAgents" },
  { key: "cost",         href: "/cost",           label: "Cost",           icon: DollarSign, tier: "hasAgents" },
  { key: "inbox",        href: "/inbox",          label: "Inbox",          icon: Inbox,      tier: "hasAgents" },
  { key: "sandboxes",    href: "/sandboxes",      label: "Sandboxes",      icon: Box,        tier: "hasAgents" },
  { key: "attestations", href: "/attestations",   label: "Attestations",   icon: FileCheck2, tier: "hasAgents" },
];

// Fetch the disclosure signals once per session and memoize — navigating between
// hub tabs shouldn't refetch. A fresh registration won't reveal new tabs until
// reload, which is an acceptable trade for a stable, flicker-free tab bar.
let countsMemo: Promise<{ agents: number; orgs: number }> | null = null;
function loadHubCounts() {
  if (!countsMemo) {
    countsMemo = Promise.all([
      api.listAgents().then(r => r.agents.length).catch(() => 0),
      api.listOrgs().then(r => r.orgs.length).catch(() => 0),
    ]).then(([agents, orgs]) => ({ agents, orgs }));
  }
  return countsMemo;
}

export function AgentsHubNav({ active }: { active: HubTabKey }) {
  const [counts, setCounts] = useState<{ agents: number; orgs: number } | null>(null);
  useEffect(() => { let live = true; loadHubCounts().then(c => { if (live) setCounts(c); }); return () => { live = false; }; }, []);

  const unlocked = (t: Tab) => {
    if (t.key === active) return true;            // never orphan the active tab
    if (t.tier === "core") return true;
    if (!counts) return false;                    // until loaded, show only core (+active)
    if (t.tier === "hasAgents") return counts.agents >= 1 || counts.orgs >= 1;
    if (t.tier === "hasOrg") return counts.orgs >= 1;
    return true;
  };

  return (
    <nav aria-label="Agents" className="-mt-1 mb-5 border-b flex items-stretch overflow-x-auto" style={{ scrollbarWidth: "none" }}>
      {TABS.filter(unlocked).map(t => {
        const Icon = t.icon;
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 px-3 min-h-11 text-sm border-b-2 -mb-px whitespace-nowrap ${
              isActive
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            }`}
          >
            <Icon className="h-4 w-4" /> {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
