"use client";

import { use, useEffect, useState } from "react";
import { api, ApiError, type Repo } from "@/lib/api";
import { splitRefPath } from "@/lib/public-repo-path";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicTreeListing } from "@/components/public/public-tree-listing";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";

export default function PublicTreePage({ params }: { params: Promise<{ ns: string; repo: string; slug: string[] }> }) {
  const { ns, repo, slug } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [branchNames, setBranchNames] = useState<string[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
    });
    api.publicBranches(ns, repo).then(r => setBranchNames(r.branches.map(b => b.name))).catch(() => setBranchNames([]));
  }, [ns, repo]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;
  if (branchNames === null) return <div className="text-muted-foreground text-sm">Loading…</div>;
  const decoded = slug.map(decodeURIComponent);
  const { ref, path } = splitRefPath(decoded, branchNames);

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />
      <PublicTreeListing ns={ns} repo={repo} refName={ref} path={path} />
    </div>
  );
}
