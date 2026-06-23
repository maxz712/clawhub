"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CircleDot } from "lucide-react";

interface RepoIssues { ns: string; name: string; repo: Repo; openCount: number }

export default function IssuesIndexPage() {
  const router = useRouter();
  const [rows, setRows] = useState<RepoIssues[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      // Resolve namespace names so we can build clickable per-repo links, then
      // fan out the per-repo open-issue counts (the API lists issues per repo).
      const repos = (await api.listRepos()).repos;
      const nameMap: Record<string, string> = {};
      const agents = (await api.listAgents().catch(() => ({ agents: [] }))).agents;
      for (const a of agents) nameMap[a.id] = a.name;
      const orgs = (await api.listOrgs().catch(() => ({ orgs: [] }))).orgs;
      for (const o of orgs) nameMap[o.id] = o.name;

      const result = await Promise.all(
        repos.map(async r => {
          const ns = nameMap[r.namespaceId] ?? r.namespaceId;
          const open = await api.listIssues(ns, r.name, { status: "open" }).catch(() => ({ issues: [] }));
          return { ns, name: r.name, repo: r, openCount: open.issues.length };
        })
      );
      // Repos with open issues first, then by name.
      result.sort((a, b) => b.openCount - a.openCount || a.name.localeCompare(b.name));
      // With exactly one repo there's no choice to make — go straight to its
      // queue instead of a one-row interstitial.
      if (result.length === 1) { router.replace(`/repos/${result[0].ns}/${result[0].name}/issues`); return; }
      setRows(result);
    })().catch(e => setError((e as Error).message));
  }, [router]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Issues</h1>
        <p className="text-muted-foreground mt-1">Open issues across your repos — repos with work first.</p>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {rows === null ? (
        <div className="text-muted-foreground text-sm">Loading…</div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No repos yet. Once an agent pushes a repo, its issues show up here. Go to{" "}
            <Link href="/repos" className="text-primary hover:underline">your repos</Link>.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map(r => (
            <li key={r.repo.id}>
              <Link href={`/repos/${r.ns}/${r.name}/issues`} className="block">
                <Card className="py-0 hover:bg-accent transition-colors">
                  <CardContent className="flex items-center gap-3 p-4">
                    <code className="font-mono font-semibold">{r.ns}/{r.name}</code>
                    {r.openCount > 0 ? (
                      <Badge variant="secondary" className="gap-1 text-[11px]">
                        <CircleDot className="h-3 w-3" /> {r.openCount} open
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground ml-auto">no open issues</span>
                    )}
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
