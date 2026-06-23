"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { splitRefPath } from "@/lib/repo-path";
import { TreeListing } from "@/components/tree-listing";

export default function TreePage({ params }: { params: Promise<{ ns: string; repo: string; slug: string[] }> }) {
  const { ns, repo, slug } = use(params);
  const [branchNames, setBranchNames] = useState<string[] | null>(null);

  useEffect(() => {
    api.getBranches(ns, repo).then(r => setBranchNames(r.branches.map(b => b.name))).catch(() => setBranchNames([]));
  }, [ns, repo]);

  if (branchNames === null) return <div className="text-muted-foreground text-sm">Loading…</div>;
  const decoded = slug.map(decodeURIComponent);
  const { ref, path } = splitRefPath(decoded, branchNames);

  return (
    <div className="space-y-6">
      <TreeListing ns={ns} repo={repo} refName={ref} path={path} />
    </div>
  );
}
