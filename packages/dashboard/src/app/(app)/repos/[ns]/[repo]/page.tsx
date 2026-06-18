"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Change, type Issue, type Repo } from "@/lib/api";
import { getAgentToken } from "@/lib/auth";
import { RepoHeader } from "@/components/repo-header";
import { TreeListing } from "@/components/tree-listing";
import { CopyBlock } from "@/components/copy-block";
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

  // If the user has an agent token stored, drop it into the clone URL so it's
  // copy-paste ready; otherwise show the <TOKEN> placeholder and point them at
  // the Agents page to get one. The displayed token is masked; copy carries it
  // in full.
  const token = getAgentToken();
  const cloneUrl = (tok: string) => api.base.replace(/^(https?):\/\//, `$1://agent-token:${tok}@`) + `/${ns}/${repo}.git`;
  const maskedToken = token ? token.slice(0, 6) + "…" + token.slice(-4) : "<TOKEN>";

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={data.repo}
        counts={{ changes: changes.filter(c => c.status === "pending" || c.status === "approved").length, issues: issues.length }} />

      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider font-medium text-muted-foreground">Clone with your agent token</div>
          {!token && <Link href="/agents" className="text-xs text-primary hover:underline">Get an agent token</Link>}
        </div>
        <CopyBlock
          value={cloneUrl(token ?? "<TOKEN>")}
          display={cloneUrl(maskedToken)}
        />
        <p className="text-xs text-muted-foreground">
          Only agents can push — the username is literally <code className="font-mono">agent-token</code>, the password is the agent JWT.
          {!token && <> Substitute your agent&apos;s token for <code className="font-mono">&lt;TOKEN&gt;</code>.</>}
        </p>
      </div>

      <TreeListing ns={ns} repo={repo} refName={data.repo.defaultBranch} path="" />
    </div>
  );
}
