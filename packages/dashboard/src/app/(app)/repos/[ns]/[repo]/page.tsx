"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { getAgentToken } from "@/lib/auth";
import { TreeListing } from "@/components/tree-listing";
import { CopyBlock } from "@/components/copy-block";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function RepoHomePage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<{ repo: Repo } | null>(null);
  // null = unknown yet; [] = a repo with no branches (no commits pushed).
  const [branchNames, setBranchNames] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The RepoHeader + Changes/Issues counts now live in the repo layout, so the
    // home page only needs the repo (for the default branch) + the branch list.
    api.getRepo(ns, repo).then(setData).catch(e => setError((e as Error).message));
    // Branch list drives the empty-repo state: a repo with no branches has no
    // commits yet, so the tree fetch would 404 — we render onboarding instead.
    api.getBranches(ns, repo).then(r => setBranchNames(r.branches.map(b => b.name))).catch(() => setBranchNames([]));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!data || branchNames === null) return <div className="text-muted-foreground">Loading…</div>;

  const isEmpty = branchNames.length === 0;

  // If the user has an agent token stored, drop it into the clone URL so it's
  // copy-paste ready; otherwise show the <TOKEN> placeholder and point them at
  // the Agents page to get one. The displayed token is masked; copy carries it
  // in full.
  const token = getAgentToken();
  const cloneUrl = (tok: string) => api.base.replace(/^(https?):\/\//, `$1://agent-token:${tok}@`) + `/${ns}/${repo}.git`;
  const maskedToken = token ? token.slice(0, 6) + "…" + token.slice(-4) : "<TOKEN>";
  const remote = (tok: string) => cloneUrl(tok);
  const remoteMasked = remote(maskedToken);
  const remoteFull = remote(token ?? "<TOKEN>");

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Remote URL (push with your agent token)</div>
          {!token && <Link href="/agents" className="text-xs text-primary hover:underline">Get an agent token</Link>}
        </div>

        {isEmpty ? (
          <div className="space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Push your first branch</div>
            <CopyBlock value={`git remote add origin ${remoteFull}`} display={`git remote add origin ${remoteMasked}`} />
            <CopyBlock value="git push -u origin HEAD" />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Clone</div>
            <CopyBlock value={`git clone ${remoteFull}`} display={`git clone ${remoteMasked}`} />
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Only agents can push — the username is literally <code className="font-mono">agent-token</code>, the password is the agent JWT.
          {!token && <> Substitute your agent&apos;s token for <code className="font-mono">&lt;TOKEN&gt;</code>.</>}
        </p>
      </div>

      {isEmpty ? (
        <div className="rounded-lg border bg-card p-8 text-center space-y-2">
          <div className="text-base font-medium">No code yet</div>
          <p className="text-sm text-muted-foreground">
            Push your first branch to get started — the first branch you push becomes the repo&apos;s default branch.
            Use the commands above, or run <code className="font-mono text-foreground">ch init</code> from the CLI.
          </p>
        </div>
      ) : (
        <TreeListing ns={ns} repo={repo} refName={data.repo.defaultBranch} path="" />
      )}
    </div>
  );
}
