"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Repo } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { pubRepoUrl } from "@/lib/public-repo-path";
import { RepoTabRow, buildRepoTabs } from "@/components/repo-tab-row";
import { Badge } from "@/components/ui/badge";
import { Star, Lock, ArrowUpRight } from "lucide-react";

/**
 * Read-only repo hub header for the logged-out public surface. Shares the exact
 * tab-row primitive with the authenticated RepoHeader (filtered to the public
 * tabs — Code / Changes / Issues), so the two surfaces can't drift, and links
 * stay within /r/<ns>/<repo>. A visitor sees "Sign in to contribute"; an already
 * authenticated visitor (arriving from a trending/profile link) instead gets an
 * "Open in dashboard" bridge to the full app surface.
 */
export function PublicRepoHeader({ ns, repo, data }: { ns: string; repo: string; data?: Repo | null }) {
  const pathname = usePathname();
  const base = pubRepoUrl(ns, repo);
  const tabs = buildRepoTabs(base).filter(t => t.public);
  // Read auth after mount so SSR and the first client render agree (no hydration
  // mismatch) before the CTA flips to the logged-in variant.
  const [authed, setAuthed] = useState(false);
  useEffect(() => { setAuthed(!!getToken()); }, []);

  return (
    <div className="space-y-0">
      <div className="flex flex-wrap items-center gap-3">
        {/* Repo identity is chrome here too — keep it a div so the page body owns the h1. */}
        <div className="text-2xl font-bold tracking-tight min-w-0 break-all" aria-label={`${ns}/${repo}`}>
          <span className="text-muted-foreground">{ns}</span>
          <span className="text-muted-foreground/60 mx-1">/</span>
          <Link href={base} className="hover:text-primary">{repo}</Link>
        </div>
        {data && <Badge variant="outline" className="text-[10px]">{data.isPublic ? "public" : "private"}</Badge>}
        {data?.forkOfRepoId && <Badge variant="outline" className="text-[10px]">fork</Badge>}

        <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5" title="Stars">
            <Star className="h-3.5 w-3.5" /> {data?.starsCount ?? 0}
          </span>
          {authed ? (
            <Link href={`/repos/${ns}/${repo}`} className="inline-flex items-center gap-1.5 text-primary hover:underline">
              <ArrowUpRight className="h-3.5 w-3.5" /> Open in dashboard
            </Link>
          ) : (
            <Link href="/login" className="inline-flex items-center gap-1.5 text-primary hover:underline">
              <Lock className="h-3.5 w-3.5" /> Sign in to contribute
            </Link>
          )}
        </div>
      </div>
      {data?.description && <p className="text-muted-foreground text-sm mt-1">{data.description}</p>}

      <RepoTabRow base={base} pathname={pathname} tabs={tabs} />
    </div>
  );
}
