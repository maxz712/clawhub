"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { DiffScratchLoader } from "@/components/diff-scratch-loader";

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

  // First-run: a logged-in user with no agents and no visible repos has
  // nothing to push from yet — lead with onboarding instead of a dead end.
  const showOnboarding = repos !== null && repos.length === 0 && agentCount === 0;

  // Mid-onboarding: the user already has an agent but hasn't pushed a repo yet.
  // The bare "No repos yet" message is a dead end with no push instructions —
  // reuse the connect card (it prints the correct scheme-preserving, owner-handle
  // remote + a usable token) so they can actually push their first repo.
  const showPushRecipe = repos !== null && repos.length === 0 && agentCount !== null && agentCount > 0;

  // Already have a repo elsewhere? Surface import alongside the push recipe so a
  // migrating user isn't only ever told to push new code (the import flow was
  // previously buried in the sidebar with no mention here).
  const importHint = (
    <div className="p-4 rounded border bg-card flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span>Already have a repo on GitHub, GitLab, or Bitbucket?</span>
      <Link href="/import" className="text-primary hover:underline font-medium">Import it →</Link>
      <span className="text-muted-foreground">— clones the code + issues into ClawHub.</span>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Repositories</h1>
        <p className="text-muted-foreground mt-1">Repos live under your account or an org. Agents push; you own every merge.</p>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!repos ? (
        <div className="flex justify-center py-16"><DiffScratchLoader label="Loading repos…" /></div>
      ) : showOnboarding ? (
        <div className="space-y-4">
          <ConnectAgentCard onConnected={() => void load()} />
          {importHint}
        </div>
      ) : showPushRecipe ? (
        <div className="space-y-4">
          <div className="p-6 rounded border bg-card">
            <p className="text-sm">
              You have an agent but no repos yet. Push your first repo to see it appear here — or grab a ready-to-run
              push recipe (remote URL + token) below.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Manage your agents on the <Link href="/agents" className="text-primary hover:underline">agents page</Link>.
            </p>
          </div>
          <ConnectAgentCard onConnected={() => void load()} />
          {importHint}
        </div>
      ) : repos.length === 0 ? (
        <div className="space-y-4">
          <div className="p-8 text-center rounded border bg-card">
            <p className="text-muted-foreground">No repos yet. Have one of your agents push code to see its first repo appear.</p>
          </div>
          {importHint}
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
