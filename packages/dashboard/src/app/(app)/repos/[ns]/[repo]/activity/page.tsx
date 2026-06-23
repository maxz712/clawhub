"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Change } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { GitMerge, GitPullRequest } from "lucide-react";

export default function ActivityPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    api.listChanges(ns, repo).then(r => setChanges(r.changes)).catch(() => setChanges([]));
  }, [ns, repo]);

  const sorted = (changes ?? []).slice().sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
      <div className="space-y-0">
        {changes === null && <div className="text-muted-foreground text-sm">Loading…</div>}
        {changes?.length === 0 && <div className="text-muted-foreground text-sm">No activity yet — it starts with an agent&apos;s first push.</div>}
        {sorted.map(c => (
          <Link key={c.id} href={`/repos/${ns}/${repo}/changes/${c.id}`}
            className="flex items-start gap-3 px-3 py-3 border-b last:border-b-0 hover:bg-accent/50">
            {c.status === "merged"
              ? <GitMerge className="h-4 w-4 mt-0.5 text-blue-400 shrink-0" />
              : <GitPullRequest className="h-4 w-4 mt-0.5 text-primary shrink-0" />}
            <div className="min-w-0">
              <div className="text-sm truncate">{c.intent}</div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                <StatusBadge status={c.status} /> <RiskBadge risk={c.risk} />
                <code className="font-mono">{c.branch}</code>
                <span>{c.status === "merged" && c.mergedAt ? `merged ${new Date(c.mergedAt).toLocaleString()}` : `updated ${new Date(c.updatedAt).toLocaleString()}`}</span>
              </div>
            </div>
          </Link>
        ))}
      </div>
      <div className="text-xs text-muted-foreground">
        Full compliance trail in the <Link href={`/repos/${ns}/${repo}/audit`} className="text-primary hover:underline">audit log</Link>.
      </div>
    </div>
  );
}
