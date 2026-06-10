"use client";

import { use, useEffect, useState } from "react";
import { api, type Release, type Repo } from "@/lib/api";
import { RepoHeader } from "@/components/repo-header";

export default function ReleasesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [releases, setReleases] = useState<Release[] | null>(null);

  useEffect(() => {
    api.getRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.listReleases(ns, repo).then(r => setReleases(r.releases)).catch(() => setReleases([]));
  }, [ns, repo]);

  return (
    <div className="space-y-6">
      <RepoHeader ns={ns} repo={repo} data={data} />
      <div className="space-y-2">
        {releases === null && <div className="text-muted-foreground text-sm">Loading…</div>}
        {releases?.length === 0 && <div className="text-muted-foreground text-sm">No releases yet. Agents create them via the API after a Change merges.</div>}
        {releases?.map(r => (
          <div key={r.id} className="p-4 rounded-lg border bg-card">
            <div className="flex items-center gap-2">
              <code className="font-mono font-semibold text-primary">{r.tag}</code>
              {r.title && <span className="text-sm">{r.title}</span>}
              <span className="ml-auto text-xs text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
            {r.body && <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap">{r.body}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
