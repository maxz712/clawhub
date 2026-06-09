"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Change, type Issue, type Repo, type Release } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { IssueRow } from "@/components/issue-row";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CodeBrowser } from "@/components/code-browser";

export default function RepoHomePage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<{ repo: Repo } | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.getRepo(ns, repo),
      api.listChanges(ns, repo),
      api.listIssues(ns, repo, { status: "open" }),
      api.listReleases(ns, repo),
    ]).then(([r, c, i, rel]) => {
      setData(r); setChanges(c.changes); setIssues(i.issues); setReleases(rel.releases);
    }).catch(e => setError((e as Error).message));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!data) return <div className="text-muted-foreground">Loading…</div>;

  const cloneUrl = api.base.replace(/^(https?):\/\//, "$1://agent-token:<TOKEN>@") + `/${ns}/${repo}.git`;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold tracking-tight break-all">{ns}/{repo}</h1>
          {data.repo.description && <p className="text-muted-foreground mt-1">{data.repo.description}</p>}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <Badge variant="outline" className="text-[10px]">default: {data.repo.defaultBranch}</Badge>
            {data.repo.isPublic && <Badge variant="secondary" className="text-[10px]">public</Badge>}
            {data.repo.forkOfRepoId && <Badge variant="outline" className="text-[10px]">fork</Badge>}
          </div>
        </div>
        <div className="flex gap-3 flex-wrap text-sm">
          <Link href={`/repos/${ns}/${repo}/security`} className="text-primary hover:underline">Security</Link>
          <Link href={`/repos/${ns}/${repo}/packages`} className="text-primary hover:underline">Packages</Link>
          <Link href={`/repos/${ns}/${repo}/milestones`} className="text-primary hover:underline">Milestones</Link>
          <Link href={`/repos/${ns}/${repo}/audit`} className="text-primary hover:underline">Audit</Link>
          <Link href={`/repos/${ns}/${repo}/settings`} className="text-primary hover:underline">Settings →</Link>
        </div>
      </header>

      <div className="rounded border bg-card p-3">
        <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Clone</div>
        <code className="font-mono text-xs break-all">{cloneUrl}</code>
      </div>

      <Tabs defaultValue="code">
        <TabsList>
          <TabsTrigger value="code">Code</TabsTrigger>
          <TabsTrigger value="changes">Changes ({changes.length})</TabsTrigger>
          <TabsTrigger value="issues">Issues ({issues.length})</TabsTrigger>
          <TabsTrigger value="releases">Releases ({releases.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="code" className="pt-4">
          <CodeBrowser ns={ns} repo={repo} defaultBranch={data.repo.defaultBranch} />
        </TabsContent>

        <TabsContent value="changes" className="space-y-2 pt-4">
          {changes.length === 0 ? (
            <div className="text-muted-foreground text-sm">No changes yet.</div>
          ) : changes.slice(0, 20).map(c => (
            <Link key={c.id} href={`/repos/${ns}/${repo}/changes/${c.id}`} className="block p-3 rounded border bg-card hover:bg-accent">
              <div className="flex items-center gap-2">
                <RiskBadge risk={c.risk} /> <StatusBadge status={c.status} /> <CiStatusPill status={c.ciStatus} />
                <code className="text-xs font-mono text-muted-foreground ml-auto">{c.branch}</code>
              </div>
              <div className="mt-1 text-sm">{c.intent}</div>
            </Link>
          ))}
          <Link href={`/repos/${ns}/${repo}/changes`} className="text-sm text-primary hover:underline">View all →</Link>
        </TabsContent>

        <TabsContent value="issues" className="space-y-2 pt-4">
          {issues.length === 0 ? <div className="text-muted-foreground text-sm">No open issues.</div> : issues.map(i => <IssueRow key={i.id} issue={i} href={`/repos/${ns}/${repo}/issues/${i.number}`} />)}
          <Link href={`/repos/${ns}/${repo}/issues`} className="text-sm text-primary hover:underline">View all →</Link>
        </TabsContent>

        <TabsContent value="releases" className="space-y-2 pt-4">
          {releases.length === 0 ? <div className="text-muted-foreground text-sm">No releases yet.</div> : releases.map(r => (
            <div key={r.id} className="p-3 rounded border bg-card">
              <code className="font-mono font-semibold">{r.tag}</code>
              {r.title && <span className="ml-2">{r.title}</span>}
              <div className="text-xs text-muted-foreground mt-1 font-mono">{new Date(r.createdAt).toLocaleString()}</div>
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
