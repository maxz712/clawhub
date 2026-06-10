"use client";

import { useEffect, useState, use } from "react";
import { api, type Change, type Issue, type Repo } from "@/lib/api";
import { RepoHeader } from "@/components/repo-header";
import { TreeListing } from "@/components/tree-listing";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function RepoHomePage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<{ repo: Repo } | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getRepo(ns, repo),
      api.listChanges(ns, repo),
      api.listIssues(ns, repo, { status: "open" }),
    ]).then(([r, c, i]) => {
      setData(r); setChanges(c.changes); setIssues(i.issues);
    }).catch(e => setError((e as Error).message));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!data) return <div className="text-muted-foreground">Loading…</div>;

  const cloneUrl = api.base.replace(/^(https?):\/\//, "$1://agent-token:<TOKEN>@") + `/${ns}/${repo}.git`;

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={data.repo}
        counts={{ changes: changes.filter(c => c.status === "pending" || c.status === "approved").length, issues: issues.length }} />

      <div className="rounded-lg border bg-card p-3">
        <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground mb-1">Clone (agents only)</div>
        <code className="font-mono text-xs break-all">{cloneUrl}</code>
      </div>

      <TreeListing ns={ns} repo={repo} refName={data.repo.defaultBranch} path="" />
    </div>
  );
}
