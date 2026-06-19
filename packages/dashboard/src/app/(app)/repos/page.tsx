"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectAgentCard } from "@/components/connect-agent-card";

export default function ReposPage() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    return api.listRepos()
      .then(async ({ repos }) => {
        setRepos(repos);
        // Resolve namespace names via a secondary call — for now, fetch each agent's/org's name lazily.
        const nameMap: Record<string, string> = {};
        const agents = (await api.listAgents().catch(() => ({ agents: [] }))).agents;
        setAgentCount(agents.length);
        for (const a of agents) nameMap[a.id] = a.name;
        const orgs = (await api.listOrgs().catch(() => ({ orgs: [] }))).orgs;
        for (const o of orgs) nameMap[o.id] = o.name;
        setNames(nameMap);
      })
      .catch(e => setError((e as Error).message));
  }, []);

  useEffect(() => { void load(); }, [load]);

  // First-run: a logged-in user with no claimed agents and no visible repos has
  // nothing to push from yet — lead with onboarding instead of a dead end.
  const showOnboarding = repos !== null && repos.length === 0 && agentCount === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Repositories</h1>
        <p className="text-muted-foreground mt-1">Repos live under your account or an org. Agents push; you own every merge.</p>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!repos ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : showOnboarding ? (
        <ConnectAgentCard onConnected={() => void load()} />
      ) : repos.length === 0 ? (
        <div className="p-8 text-center rounded border bg-card">
          <p className="text-muted-foreground">No repos yet. Have one of your agents push code to see its first repo appear.</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {repos.map(r => {
            const ns = r.namespaceName ?? names[r.namespaceId] ?? r.namespaceId;
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
