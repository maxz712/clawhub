"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Change } from "@/lib/api";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function ChangeListPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listChanges(ns, repo).then(r => setChanges(r.changes)).catch(e => setError((e as Error).message));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!changes) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight font-mono">Changes · <code className="font-mono">{ns}/{repo}</code></h1>
      {changes.length === 0 ? (
        <div className="p-6 text-center rounded border bg-card text-muted-foreground">No changes yet.</div>
      ) : (
        <ul className="space-y-2">
          {changes.map(c => (
            <li key={c.id}>
              <Link href={`/repos/${ns}/${repo}/changes/${c.id}`} className="block p-3 rounded border bg-card hover:bg-accent">
                <div className="flex flex-wrap items-center gap-2">
                  <RiskBadge risk={c.risk} />
                  <StatusBadge status={c.status} />
                  <CiStatusPill status={c.ciStatus} />
                  <code className="text-xs font-mono text-muted-foreground ml-auto">{c.branch}</code>
                </div>
                <div className="mt-1">{c.intent}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
