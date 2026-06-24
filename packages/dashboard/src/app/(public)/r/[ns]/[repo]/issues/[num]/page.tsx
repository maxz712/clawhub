"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ApiError, type Issue, type IssueComment, type IssueChangeLink, type Repo } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Markdown } from "@/components/markdown";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";
import { pubRepoUrl } from "@/lib/public-repo-path";
import { useDocumentTitle } from "@/lib/use-document-title";
import { GitPullRequest } from "lucide-react";

export default function PublicIssueDetail({ params }: { params: Promise<{ ns: string; repo: string; num: string }> }) {
  const { ns, repo, num } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [links, setLinks] = useState<IssueChangeLink[]>([]);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.publicIssue(ns, repo, Number(num)).then(r => { setIssue(r.issue); setComments(r.comments); setLinks(r.links ?? []); })
      .catch(e => { if (e instanceof ApiError && e.status === 404) setNotFound(true); });
  }, [ns, repo, num]);

  useDocumentTitle(issue ? `${issue.title} · #${issue.number} · ${ns}/${repo}` : `Issue · ${ns}/${repo}`);

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
            <Card><CardContent className="pt-6"><Markdown>{issue.body}</Markdown></CardContent></Card>
          )}

          {links.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><GitPullRequest className="h-4 w-4" /> Linked changes</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {links.map(l => (
                  <Link key={l.id} href={`${pubRepoUrl(ns, repo)}/changes/${l.id}`}
                    className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5 hover:bg-accent">
                    <code className="font-mono text-xs text-primary truncate" title={l.branch}>{displayBranch(l.branch)}</code>
                    <Badge variant="secondary" className="text-[10px] uppercase shrink-0">{l.status}</Badge>
                    {l.intent && <span className="text-xs text-muted-foreground truncate hidden sm:inline">{l.intent}</span>}
                  </Link>
                ))}
              </CardContent>
            </Card>
          )}

          <div className="space-y-3">
            <div className="text-sm font-medium text-muted-foreground">{comments.length} comment{comments.length === 1 ? "" : "s"}</div>
            {comments.map(cm => (
              <Card key={cm.id}>
                <CardContent className="pt-4 space-y-1">
                  <div className="text-xs text-muted-foreground">{cm.authorKind} · {new Date(cm.createdAt).toLocaleString()}</div>
                  <Markdown>{cm.body}</Markdown>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="pt-4 text-sm text-muted-foreground">
              <Link href="/login" className="text-primary hover:underline">Sign in</Link> to comment or assign an agent.
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
