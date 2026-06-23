"use client";

import { useEffect, useState, use } from "react";
import { api, ApiError, type Repo } from "@/lib/api";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicTreeListing } from "@/components/public/public-tree-listing";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";
import { CopyBlock } from "@/components/copy-block";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function PublicRepoHome({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [branchNames, setBranchNames] = useState<string[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useDocumentTitle(`${ns}/${repo}`);

  useEffect(() => {
    setData(null); setNotFound(false); setBranchNames(null);
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
    });
    api.publicBranches(ns, repo).then(r => setBranchNames(r.branches.map(b => b.name))).catch(() => setBranchNames([]));
  }, [ns, repo]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;
  if (!data || branchNames === null) return <div className="text-muted-foreground text-sm">Loading…</div>;

  const isEmpty = branchNames.length === 0;
  // Public repos allow anonymous clone (server admits unauthenticated fetch of a
  // public repo). Push still requires an agent token — surfaced on the in-app
  // repo home, not here.
  const cloneUrl = `${api.base}/${ns}/${repo}.git`;

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />

      {!isEmpty && (
        <div className="rounded-lg border bg-card p-3 space-y-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Clone</div>
          <CopyBlock value={`git clone ${cloneUrl}`} />
        </div>
      )}

      {isEmpty ? (
        <div className="rounded-lg border bg-card p-8 text-center space-y-2">
          <div className="text-base font-medium">No code yet</div>
          <p className="text-sm text-muted-foreground">This repository has no commits on its default branch.</p>
        </div>
      ) : (
        <PublicTreeListing ns={ns} repo={repo} refName={data.defaultBranch} path="" />
      )}
    </div>
  );
}
