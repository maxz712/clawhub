"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, effectiveRisk, type Change } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { CiStatusPill } from "@/components/ci-status-pill";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { GitFork } from "lucide-react";

export default function ChangeListPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Cross-repo proposals live under the repo but have no tab — surface a subtle
  // link here so the incoming-proposals page isn't reachable by URL alone.
  // Best-effort: a failed fetch (e.g. no write access) just hides the link.
  const [incomingCount, setIncomingCount] = useState(0);

  useEffect(() => {
    api.listChanges(ns, repo).then(r => setChanges(r.changes)).catch(e => setError((e as Error).message));
    api.listIncomingProposals(ns, repo)
      .then(r => setIncomingCount(r.proposals.filter(p => p.status === "open").length))
      .catch(() => setIncomingCount(0));
  }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!changes) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Changes</h1>
        {incomingCount > 0 && (
          <Link
            href={`/repos/${ns}/${repo}/proposals`}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <GitFork className="h-3.5 w-3.5" />
            {incomingCount} incoming proposal{incomingCount === 1 ? "" : "s"}
          </Link>
        )}
      </div>
      {changes.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground space-y-1.5">
            <div>No changes yet.</div>
            <div className="text-sm">
              Changes open when your agent pushes a branch (or to <code className="font-mono text-xs">refs/for/&lt;branch&gt;</code>).{" "}
              <Link href={`/repos/${ns}/${repo}`} className="text-primary underline underline-offset-2">See the clone &amp; setup steps</Link>.
            </div>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {changes.map(c => (
            <li key={c.id}>
              <Card className="hover:bg-accent transition-colors">
                <Link href={`/repos/${ns}/${repo}/changes/${c.id}`} className="block">
                  <CardContent className="p-3">
                    <div className="font-medium">{c.intent || "(no intent declared)"}</div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2">
                      <RiskBadge risk={effectiveRisk(c)} />
                      <StatusBadge status={c.status} />
                      <CiStatusPill status={c.ciStatus} />
                      {(c.openedByUserName ?? c.openedByAgentName) && (
                        <span className="text-xs text-muted-foreground">by <span className="font-mono">@{c.openedByUserName ?? c.openedByAgentName}</span></span>
                      )}
                      <code className="text-xs font-mono text-muted-foreground ml-auto" title={c.branch}>{displayBranch(c.branch)}</code>
                    </div>
                  </CardContent>
                </Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
