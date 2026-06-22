"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Risk, type CiStatus } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RiskBadge } from "@/components/risk-badge";
import { CiStatusPill } from "@/components/ci-status-pill";

type RepoHealth = { id: string; name: string; openChanges: number; maxOpenRisk: Risk | null; ciStatus: CiStatus | null; lastActivity: string | null };

/**
 * Per-repo health rollup for the org dashboard: open changes, the worst CI
 * status + highest risk among those open changes, and last activity — so a fleet
 * manager sees which repos need attention instead of just an updatedAt column.
 */
export function OrgReposHealth({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [repos, setRepos] = useState<RepoHealth[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.orgReposHealth(orgId).then(r => setRepos(r.repos)).catch(e => setError((e as Error).message));
  }, [orgId]);

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Repos health</CardTitle></CardHeader>
      <CardContent>
        {error ? <div className="text-sm text-destructive">{error}</div>
          : repos === null ? <div className="text-sm text-muted-foreground">Loading…</div>
          : repos.length === 0 ? <div className="text-sm text-muted-foreground">No repos in this org yet.</div>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Repo</th>
                    <th className="py-1.5 px-3 font-medium">Open</th>
                    <th className="py-1.5 px-3 font-medium">CI</th>
                    <th className="py-1.5 px-3 font-medium">Max risk</th>
                    <th className="py-1.5 pl-3 font-medium text-right">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {repos.map(r => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-2 pr-3">
                        <Link href={`/repos/${orgName}/${r.name}`} className="font-mono text-primary hover:underline">{r.name}</Link>
                      </td>
                      <td className="py-2 px-3">{r.openChanges > 0 ? <span className="font-mono">{r.openChanges}</span> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-2 px-3">{r.ciStatus ? <CiStatusPill status={r.ciStatus} /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-2 px-3">{r.maxOpenRisk ? <RiskBadge risk={r.maxOpenRisk} /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-2 pl-3 text-right text-xs text-muted-foreground font-mono">{r.lastActivity ? new Date(r.lastActivity).toLocaleDateString() : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardContent>
    </Card>
  );
}
