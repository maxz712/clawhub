"use client";

import { use, useEffect, useState } from "react";
import { api, type Repo } from "@/lib/api";
import { RepoHeader } from "@/components/repo-header";

/**
 * Repo-scoped layout: renders ONE persistent RepoHeader above every repo route.
 * The App Router keeps a layout mounted across navigation between its children,
 * so the tab bar no longer vanishes when you open Changes/Issues/Settings, the
 * star/fork state + counts are fetched once (not re-fetched per tab click), and
 * child pages drop their own <RepoHeader> render. Counts mirror the home page's
 * semantics — open issues, pending|approved changes — so the badge value (not
 * just its presence) is unchanged.
 */
export default function RepoLayout({ children, params }: {
  children: React.ReactNode;
  params: Promise<{ ns: string; repo: string }>;
}) {
  const { ns, repo } = use(params);
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [counts, setCounts] = useState<{ changes?: number; issues?: number }>({});

  useEffect(() => {
    let cancelled = false;
    setRepoData(null);
    setCounts({});
    api.getRepo(ns, repo).then(r => { if (!cancelled) setRepoData(r.repo); }).catch(() => {});
    api.listChanges(ns, repo)
      .then(r => { if (!cancelled) setCounts(c => ({ ...c, changes: r.changes.filter(x => x.status === "pending" || x.status === "approved").length })); })
      .catch(() => {});
    api.listIssues(ns, repo, { status: "open" })
      .then(r => { if (!cancelled) setCounts(c => ({ ...c, issues: r.issues.length })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [ns, repo]);

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={repoData} counts={counts} />
      {children}
    </div>
  );
}
