"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { TabBar, type TabItem } from "@/components/tab-bar";
import { Bot, Boxes, Brain, Box, DollarSign, FileSignature, Inbox, LayoutTemplate, Power, Rocket, Users } from "lucide-react";

// The unified Agents section. ONE shared TabBar (same component as the repo
// tabs) renders here for every /agents/* route, so the whole section lives
// under the /agents URL and the bar looks + behaves identically everywhere.
// Progressive disclosure mirrors "Solo = N=1; same code as a team fleet": a
// brand-new user sees only the core tabs; the rest reveal once they run an
// agent. The overflow folds into "More" (never a runaway scroll). The active
// tab is always shown even if its tier hasn't unlocked.

type Tier = "core" | "hasAgents";
type HubTab = TabItem & { tier: Tier };

const TABS: HubTab[] = [
  { key: "overview",   href: "/agents",            label: "Overview",          icon: Bot,           group: "primary", exact: true, tier: "core" },
  { key: "roles",      href: "/agents/roles",      label: "Roles",             icon: Boxes,         group: "primary", tier: "core" },
  { key: "templates",  href: "/agents/templates",  label: "Templates",         icon: LayoutTemplate, group: "primary", tier: "core" },
  { key: "standing",   href: "/agents/standing",   label: "Standing agents",   icon: Rocket,        group: "primary", tier: "core" },
  { key: "memory",     href: "/agents/memory",     label: "Memory",            icon: Brain,         group: "primary", tier: "core" },
  { key: "fleet",      href: "/agents/fleet",      label: "Fleet",             icon: Users,         group: "primary", tier: "hasAgents" },
  { key: "ops",        href: "/agents/ops",        label: "Incident ops",      icon: Power,         group: "more",    tier: "core" },
  { key: "cost",       href: "/agents/cost",       label: "Cost",              icon: DollarSign,    group: "more",    tier: "hasAgents" },
  { key: "inbox",      href: "/agents/inbox",      label: "Inbox",             icon: Inbox,         group: "more",    tier: "hasAgents" },
  { key: "sandboxes",  href: "/agents/sandboxes",  label: "Sandboxes",         icon: Box,           group: "more",    tier: "hasAgents" },
  { key: "signatures", href: "/agents/signatures", label: "Commit signatures", icon: FileSignature, group: "more",    tier: "hasAgents" },
];

// Routes that get the hub tab bar. Anything else under /agents/ (e.g. an agent
// detail page /agents/<id>) is a drill-down and renders without the bar.
const HUB_PREFIXES = TABS.map(t => t.href).filter(h => h !== "/agents");

// Fetch the disclosure signals once and memoize — navigating between hub tabs
// shouldn't refetch. A fresh registration won't reveal new tabs until reload,
// an acceptable trade for a stable, flicker-free bar.
let countsMemo: Promise<{ agents: number; orgs: number }> | null = null;
let countsMemoToken: string | null = null;
function loadHubCounts() {
  // Bust the memo when the auth token changes (logout/login) so one user never
  // inherits another's disclosure state.
  const token = getToken();
  if (!countsMemo || countsMemoToken !== token) {
    countsMemoToken = token;
    countsMemo = Promise.all([
      api.listAgents().then(r => r.agents.length).catch(() => 0),
      api.listOrgs().then(r => r.orgs.length).catch(() => 0),
    ]).then(([agents, orgs]) => ({ agents, orgs }));
  }
  return countsMemo;
}

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [counts, setCounts] = useState<{ agents: number; orgs: number } | null>(null);
  useEffect(() => { let live = true; loadHubCounts().then(c => { if (live) setCounts(c); }); return () => { live = false; }; }, []);

  const showBar = pathname === "/agents" || HUB_PREFIXES.some(p => pathname === p || pathname.startsWith(p + "/"));

  const unlocked = (t: HubTab) => {
    if (t.tier === "core") return true;
    // Always keep the active tab visible even before counts load / unlock.
    if (pathname === t.href || pathname.startsWith(t.href + "/")) return true;
    if (!counts) return false;
    return counts.agents >= 1 || counts.orgs >= 1;   // hasAgents tier
  };

  return (
    <div>
      {showBar && <TabBar ariaLabel="Agents" className="mb-5" pathname={pathname} items={TABS.filter(unlocked)} />}
      {children}
    </div>
  );
}
