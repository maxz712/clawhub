"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, ApiError, effectiveRisk, type Change, type Repo } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { displayBranch } from "@/lib/branch";
import { PublicRepoHeader } from "@/components/public/public-repo-header";
import { PublicRepoNotFound } from "@/components/public/public-repo-not-found";
import { pubRepoUrl } from "@/lib/public-repo-path";
import { useDocumentTitle } from "@/lib/use-document-title";

export default function PublicChangesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [data, setData] = useState<Repo | null>(null);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [notFound, setNotFound] = useState(false);

  useDocumentTitle(`Changes · ${ns}/${repo}`);

  useEffect(() => {
    api.publicRepo(ns, repo).then(r => setData(r.repo)).catch(() => {});
    api.publicChanges(ns, repo).then(r => setChanges(r.changes)).catch(e => {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setChanges([]);
    });
  }, [ns, repo]);

  if (notFound) return <PublicRepoNotFound ns={ns} repo={repo} />;

  return (
    <div className="space-y-6">
      <PublicRepoHeader ns={ns} repo={repo} data={data} />
      {changes === null ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : changes.length === 0 ? (
        <div className="p-6 text-center rounded border bg-card text-muted-foreground">No changes yet.</div>
      ) : (
        <ul className="space-y-2">
          {changes.map(c => (
            <li key={c.id}>
              <Link href={`${pubRepoUrl(ns, repo)}/changes/${c.id}`} className="block p-3 rounded border bg-card hover:bg-accent">
                <div className="font-medium">{c.intent || "(no intent declared)"}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <RiskBadge risk={effectiveRisk(c)} />
                  <StatusBadge status={c.status} />
                  <CiStatusPill status={c.ciStatus} />
                  <code className="text-xs font-mono text-muted-foreground ml-auto" title={c.branch}>{displayBranch(c.branch)}</code>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
