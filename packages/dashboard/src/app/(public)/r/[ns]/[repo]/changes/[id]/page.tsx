"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ApiError, effectiveRisk, type Change, type LinkedIssue, type Repo } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { DiffReview } from "@/components/diff-review";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";
import { pubRepoUrl } from "@/lib/public-repo-path";

export default function PublicChangeDetail({ params }: { params: Promise<{ ns: string; repo: string; id: string }> }) {
  const { ns, repo, id } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [openerName, setOpenerName] = useState<string | null>(null);
  const [linkedIssues, setLinkedIssues] = useState<LinkedIssue[]>([]);
  const [diff, setDiff] = useState<string>("");
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.publicChange(ns, repo, id).then(r => {
      setChange(r.change); setOpenerName(r.openerName); setLinkedIssues(r.linkedIssues ?? []);
    }).catch(e => { if (e instanceof ApiError && e.status === 404) setNotFound(true); });
    api.publicDiff(ns, repo, id, "full").then(r => setDiff(r.diff)).catch(() => setDiff(""));
  }, [ns, repo, id]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />
      {!change ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : (
        <div className="space-y-4 min-w-0">
          <div className="space-y-2">
            <h1 className="text-xl font-bold tracking-tight">{change.intent || "(no intent declared)"}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge risk={effectiveRisk(change)} />
              <StatusBadge status={change.status} />
              <CiStatusPill status={change.ciStatus} />
              {openerName && <span className="text-xs text-muted-foreground">by <span className="font-mono text-primary">@{openerName}</span></span>}
              <code className="text-xs font-mono text-muted-foreground ml-auto">{change.branch}</code>
            </div>
            {change.scope?.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {change.scope.map(s => <code key={s} className="text-[11px] font-mono rounded border border-border px-1.5 py-0.5 text-muted-foreground">{s}</code>)}
              </div>
            )}
          </div>

          {linkedIssues.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Fixes</span>
              {linkedIssues.map(li => (
                <Link key={li.number} href={`${pubRepoUrl(ns, repo)}/issues/${li.number}`}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-accent">
                  <code className="font-mono text-xs">#{li.number}</code>
                  <span className="text-xs text-muted-foreground truncate max-w-[16rem]">{li.title}</span>
                </Link>
              ))}
            </div>
          )}

          {diff ? (
            <DiffReview diff={diff} focus={change.reviewFocus ?? []} />
          ) : (
            <div className="text-muted-foreground text-sm p-4 rounded-lg border bg-card">No diff available.</div>
          )}

          <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
            Want to review or merge this change?{" "}
            <Link href="/login" className="text-primary hover:underline">Sign in</Link>{" "}
            — only agents commit; humans supervise.
          </div>
        </div>
      )}
    </div>
  );
}
