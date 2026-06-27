"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, effectiveRisk, type AttentionItem } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { ActivityFeed } from "@/components/activity-feed";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { DiffScratchLoader } from "@/components/diff-scratch-loader";
import { RiskBadge } from "@/components/risk-badge";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2 } from "lucide-react";

export default function HomePage() {
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentCount, setAgentCount] = useState<number | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);

  const load = useCallback(() => {
    // Distinguish a real failure from an empty queue: a network/500/expired-
    // session error must NOT render the "nothing needs you" all-clear (a false
    // sense of safety). Track the error and show a retry instead. On a REFRESH
    // failure (a populated queue is already on screen — load() re-runs on every
    // live SSE tick) keep the last-known items rather than blanking a working
    // queue; the error banner only takes over the INITIAL load (items === null).
    api.getAttention().then(r => { setItems(r.items); setLoadError(null); }).catch(e => { setItems(prev => prev); setLoadError((e as Error).message || "Couldn't load your queue"); });
    api.listAgents().then(r => setAgentCount(r.agents.length)).catch(() => setAgentCount(null));
    api.listRepos().then(r => setRepoCount(r.repos.length)).catch(() => setRepoCount(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Stay live: re-run the attention query when a relevant event lands (a push, a
  // review, a CI flip) instead of only on mount. Debounced so a burst of events
  // collapses into one refetch.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // replay:false — this stream only TRIGGERS an attention refetch on live
    // events; the backlog would be redundant (ActivityFeed renders it, and we
    // re-query getAttention anyway).
    const es = new EventSource(api.eventStreamUrl({ replay: false }));
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => { if (t) clearTimeout(t); t = setTimeout(() => load(), 800); };
    const types = ["change.opened", "change.updated", "change.merged", "change.rolled_back", "review.submitted", "ci.completed"];
    types.forEach(ev => es.addEventListener(ev, refresh));
    return () => { if (t) clearTimeout(t); es.close(); };
  }, [load]);

  // A brand-new user who hasn't built a workflow yet — lead with the onboarding
  // card instead of a misleading "queue is clear" all-done message. Show it when
  // they have no agents OR no repos yet (having an agent but no pushed repo —
  // e.g. right after import mints an agent — still isn't "all done"). A null
  // count means the fetch failed/hasn't resolved: treat as "unknown, not zero"
  // (still offer onboarding) rather than claiming the queue is clear.
  const showOnboarding = agentCount === null || agentCount === 0 || repoCount === 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Needs your attention</h1>
        <p className="text-muted-foreground mt-1">Open changes across your repos — escalations and high risk first.</p>
      </div>

      {showOnboarding && <ConnectAgentCard onConnected={() => load()} />}

      {loadError && items === null ? (
        <div className="flex items-center justify-between gap-3 p-4 rounded border border-destructive/40 bg-destructive/10 text-sm">
          <span className="text-destructive">Couldn&apos;t load your queue — {loadError}</span>
          <button onClick={() => load()} className="shrink-0 rounded border border-destructive/40 px-2.5 py-1 text-xs font-medium text-destructive hover:bg-destructive/15">Retry</button>
        </div>
      ) : items === null ? (
        <div className="flex justify-center py-16"><DiffScratchLoader label="Loading your queue…" /></div>
      ) : items.length === 0 ? (
        !showOnboarding && (
          <Card className="py-0">
            <CardContent className="flex items-center gap-3 p-4 text-sm text-muted-foreground">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              Every open change is reviewed — nothing needs you right now.
            </CardContent>
          </Card>
        )
      ) : (
        <div className="space-y-2">
          {items.map(({ change, repo, reasons }) => (
            <Link key={change.id} href={`/repos/${repo.ns}/${repo.name}/changes/${change.id}`} className="block">
              <Card className="py-0 hover:bg-accent">
                <CardContent className="p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RiskBadge risk={effectiveRisk(change)} />
                    <StatusBadge status={change.status} />
                    {reasons.map(r => (
                      <Badge key={r}
                        variant={r === "awaiting review" ? "default" : r.startsWith("approved") ? "secondary" : "destructive"}
                        className="text-[10px]">
                        {r}
                      </Badge>
                    ))}
                    <code className="text-xs font-mono text-muted-foreground ml-auto min-w-0 break-all">{repo.ns}/{repo.name}</code>
                  </div>
                  <div className="mt-1 text-sm break-words">{change.intent}</div>
                  <div className="text-xs text-muted-foreground mt-1 break-words">
                    opened {new Date(change.createdAt).toLocaleString()}
                    {(change.openedByUserName ?? change.openedByAgentName) && (
                      <> by <span className="font-mono">@{change.openedByUserName ?? change.openedByAgentName}</span></>
                    )}
                    {" · "}branch <code className="font-mono" title={change.branch}>{displayBranch(change.branch)}</code>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div>
        <h2 className="text-xl font-semibold tracking-tight">Activity</h2>
        <p className="text-muted-foreground text-sm mt-0.5 mb-4">Live stream of changes, reviews, and CI runs.</p>
        <ActivityFeed />
      </div>
    </div>
  );
}
