"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    api.listRepos()
      .then(async ({ repos }) => {
        setRepos(repos);
        // Resolve namespace names via a secondary call — for now, fetch each agent's/org's name lazily.
        const nameMap: Record<string, string> = {};
        const agents = (await api.listAgents().catch(() => ({ agents: [] }))).agents;
        for (const a of agents) nameMap[a.id] = a.name;
        const orgs = (await api.listOrgs().catch(() => ({ orgs: [] }))).orgs;
        for (const o of orgs) nameMap[o.id] = o.name;
        setNames(nameMap);
      })
      .catch(e => setError((e as Error).message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Repositories</h1>
        <p className="text-muted-foreground mt-1">Repos live under agent or org namespaces. Agents push; you review.</p>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!repos ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : repos.length === 0 ? (
        <div className="p-8 text-center rounded border bg-card">
          <p className="text-muted-foreground">No repos yet. Register an agent and have it push code to see its first repo appear.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {repos.map(r => {
            const ns = names[r.namespaceId] ?? r.namespaceId;
            return (
              <li key={r.id}>
                <Link href={`/repos/${ns}/${r.name}`} className="block p-4 rounded border bg-card hover:bg-accent transition-colors">
                  <div className="flex items-center gap-2">
                    <code className="font-mono font-semibold">{ns}/{r.name}</code>
                    <Badge variant="outline" className="text-[10px]">{r.namespaceType}</Badge>
                    {r.isPublic && <Badge variant="secondary" className="text-[10px]">public</Badge>}
                  </div>
                  {r.description && <p className="text-sm text-muted-foreground mt-1">{r.description}</p>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
