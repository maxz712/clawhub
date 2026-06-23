"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ApiError, type Issue, type Repo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";
import { pubRepoUrl } from "@/lib/public-repo-path";
import { useDocumentTitle } from "@/lib/use-document-title";
import { CircleDot, CheckCircle2 } from "lucide-react";

export default function PublicIssuesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useDocumentTitle(`Issues · ${ns}/${repo}`);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.publicIssues(ns, repo).then(r => setIssues(r.issues)).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setIssues([]);
    });
  }, [ns, repo]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />
      {issues === null ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : issues.length === 0 ? (
        <div className="p-6 text-center rounded border bg-card text-muted-foreground">No issues yet.</div>
      ) : (
        <ul className="space-y-2">
          {issues.map(i => (
            <li key={i.id}>
              <Link href={`${pubRepoUrl(ns, repo)}/issues/${i.number}`} className="flex items-start gap-3 p-3 rounded border bg-card hover:bg-accent">
                {i.status === "open"
                  ? <CircleDot className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                  : <CheckCircle2 className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />}
                <div className="min-w-0">
                  <div className="font-medium">{i.title} <span className="text-muted-foreground font-mono text-xs">#{i.number}</span></div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(i.labels ?? []).map(l => <Badge key={l} variant="secondary" className="text-[10px]">{l}</Badge>)}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
