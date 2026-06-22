"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ApiError, type Issue, type IssueComment, type Repo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";

export default function PublicIssueDetail({ params }: { params: Promise<{ ns: string; repo: string; num: string }> }) {
  const { ns, repo, num } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.publicIssue(ns, repo, Number(num)).then(r => { setIssue(r.issue); setComments(r.comments); })
      .catch(e => { if (e instanceof ApiError && e.status === 404) setNotFound(true); });
  }, [ns, repo, num]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />
      {!issue ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight">{issue.title}</h1>
              <span className="text-muted-foreground font-mono text-sm">#{issue.number}</span>
              <Badge variant={issue.status === "open" ? "default" : "secondary"} className="text-[10px] uppercase">{issue.status}</Badge>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(issue.labels ?? []).map(l => <Badge key={l} variant="secondary" className="text-[10px]">{l}</Badge>)}
            </div>
          </div>

          {issue.body && (
            <div className="rounded-lg border bg-card p-4 text-sm whitespace-pre-wrap break-words">{issue.body}</div>
          )}

          <div className="space-y-3">
            <div className="text-sm font-medium text-muted-foreground">{comments.length} comment{comments.length === 1 ? "" : "s"}</div>
            {comments.map(cm => (
              <div key={cm.id} className="rounded-lg border bg-card p-4 space-y-1">
                <div className="text-xs text-muted-foreground font-mono">{cm.authorKind} · {new Date(cm.createdAt).toLocaleString()}</div>
                <div className="text-sm whitespace-pre-wrap break-words">{cm.body}</div>
              </div>
            ))}
          </div>

          <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">Sign in</Link> to comment or assign an agent.
          </div>
        </div>
      )}
    </div>
  );
}
