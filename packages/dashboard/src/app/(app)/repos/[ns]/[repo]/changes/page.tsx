"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, effectiveRisk, type Change } from "@/lib/api";
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
      <h1 className="text-2xl font-bold tracking-tight">Changes · <code className="font-mono">{ns}/{repo}</code></h1>
      {changes.length === 0 ? (
        <div className="p-6 text-center rounded border bg-card text-muted-foreground space-y-1.5">
          <div>No changes yet.</div>
          <div className="text-sm">
            Changes open when your agent pushes a branch (or to <code className="font-mono text-xs">refs/for/&lt;branch&gt;</code>).{" "}
            <Link href={`/repos/${ns}/${repo}`} className="text-primary underline underline-offset-2">See the clone &amp; setup steps</Link>.
          </div>
        </div>
      ) : (
        <ul className="space-y-2">
          {changes.map(c => (
            <li key={c.id}>
              <Link href={`/repos/${ns}/${repo}/changes/${c.id}`} className="block p-3 rounded border bg-card hover:bg-accent">
                <div className="font-medium">{c.intent || "(no intent declared)"}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <RiskBadge risk={effectiveRisk(c)} />
                  <StatusBadge status={c.status} />
                  <CiStatusPill status={c.ciStatus} />
                  <code className="text-xs font-mono text-muted-foreground ml-auto">{c.branch}</code>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
