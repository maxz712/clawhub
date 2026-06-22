"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Repo } from "@/lib/api";
import { pubRepoUrl } from "@/lib/public-repo-path";
import { Badge } from "@/components/ui/badge";
import { Code2, GitPullRequest, CircleDot, Star, Lock } from "lucide-react";

/**
 * Read-only repo hub header for the logged-out public surface. Mirrors
 * RepoHeader's identity + tab row, minus every write affordance (no star/watch
 * toggle, no Settings/Security/CI tabs, no agent-token clone). Tabs cover the
 * three read surfaces a visitor can browse — Code / Changes / Issues — and link
 * within /r/<ns>/<repo>. A "Sign in to contribute" CTA nudges toward signup.
 */
export function PublicRepoHeader({ ns, repo, data }: { ns: string; repo: string; data?: Repo | null }) {
  const pathname = usePathname();
  const base = pubRepoUrl(ns, repo);

  const TABS = [
    { href: base, label: "Code", icon: Code2, exact: false, also: [`${base}/tree`, `${base}/blob`] },
    { href: `${base}/changes`, label: "Changes", icon: GitPullRequest },
    { href: `${base}/issues`, label: "Issues", icon: CircleDot },
  ];
  const isActive = (t: typeof TABS[number]) =>
    t.href === base
      ? pathname === base || (t.also ?? []).some(p => pathname.startsWith(p))
      : pathname.startsWith(t.href);

  return (
    <div className="space-y-0">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight min-w-0 break-all">
          <span className="text-muted-foreground">{ns}</span>
          <span className="text-muted-foreground/60 mx-1">/</span>
          <Link href={base} className="hover:text-primary">{repo}</Link>
        </h1>
        {data && <Badge variant="outline" className="text-[10px]">{data.isPublic ? "public" : "private"}</Badge>}
        {data?.forkOfRepoId && <Badge variant="outline" className="text-[10px]">fork</Badge>}

        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5" title="Stars">
            <Star className="h-3.5 w-3.5" /> {data?.starsCount ?? 0}
          </span>
          <Link href="/login" className="inline-flex items-center gap-1.5 text-primary hover:underline">
            <Lock className="h-3.5 w-3.5" /> Sign in to contribute
          </Link>
        </div>
      </div>
      {data?.description && <p className="text-muted-foreground text-sm mt-1">{data.description}</p>}

      <div className="flex items-center gap-1 mt-4 border-b overflow-x-auto">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = isActive(t);
          return (
            <Link key={t.label} href={t.href}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap ${
                active ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"}`}>
              <Icon className="h-4 w-4" /> {t.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
