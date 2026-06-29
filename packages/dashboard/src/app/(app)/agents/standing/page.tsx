"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo, type StandingAgentWithRepo } from "@/lib/api";
import { StandingAgentsPanel } from "@/components/standing-agents-panel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, Pause, Trash2, AlertTriangle } from "lucide-react";

const ALL = "__all";

// Standing agents — bring-your-own-AI agents ClawHub runs 24/7 on a repo —
// surfaced in the one Agents hub. Defaults to a cross-repo "All repos" roster
// (the fleet operator's overview); pick a repo to get the full per-repo panel
// with the Attach flow. Same per-repo API either way.
export default function HubStandingAgentsPage() {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [selected, setSelected] = useState<string>(ALL);   // ALL or "ns/name"

  useEffect(() => {
    api.listRepos({ limit: 200 }).then(r => {
      setRepos(r.repos);
      const want = new URLSearchParams(window.location.search).get("repo");
      if (want && r.repos.find(x => `${x.namespaceName}/${x.name}` === want)) setSelected(want);
    }).catch(() => setRepos([]));
  }, []);

  const [ns, repo] = selected === ALL ? [null, null] : selected.split("/");

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Standing agents</h1>
          <p className="text-sm text-muted-foreground mt-1">Bring-your-own-AI agents ClawHub runs on a schedule, continuously, or on events — across all your repos, or pick one to attach a new one.</p>
        </div>
        {repos && repos.length > 0 && (
          <div className="min-w-56">
            <Label className="text-xs text-muted-foreground">Repo</Label>
            <Select value={selected} onValueChange={v => { if (v) setSelected(v); }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick a repo">{(v: string) => v === ALL ? "All repos" : v}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All repos</SelectItem>
                {repos.map(r => {
                  const slug = `${r.namespaceName}/${r.name}`;
                  return <SelectItem key={r.id} value={slug}>{slug}</SelectItem>;
                })}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {repos === null ? <div className="text-sm text-muted-foreground">Loading…</div>
        : repos.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No repos yet. Standing agents attach to a repo — <Link href="/repos" className="text-primary hover:underline">create or import one</Link> first.
          </div>
        ) : selected === ALL ? (
          <AllStandingAgents />
        ) : ns && repo ? (
          <StandingAgentsPanel ns={ns} repo={repo} />
        ) : null}
    </div>
  );
}

function triggerLabel(s: StandingAgentWithRepo): string {
  switch (s.trigger) {
    case "continuous": return `continuous · every ${s.intervalSec}s`;
    case "schedule": return `schedule · ${s.cron ?? "?"} (UTC)`;
    case "event": return `event · ${s.event ?? "?"}`;
    default: return "manual";
  }
}

// Cross-repo roster: every standing agent the caller governs, grouped by repo.
// Actions route back to each row's own repo (run/pause/remove); attaching a new
// agent is repo-specific, so we point there.
function AllStandingAgents() {
  const [rows, setRows] = useState<StandingAgentWithRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try { const r = await api.listMyStandingAgents(); setRows(r.standingAgents); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  async function act(s: StandingAgentWithRepo, fn: () => Promise<unknown>) {
    if (!s.repoNs || !s.repoName) return;
    setBusy(s.id); setError(null);
    try { await fn(); await load(); } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (rows === null) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (rows.length === 0) return (
    <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
      No standing agents yet. Pick a repo above to attach one.
    </div>
  );

  // Group by repo, preserving the (recency-ordered) row order within each.
  const groups = new Map<string, StandingAgentWithRepo[]>();
  for (const s of rows) {
    const key = s.repoNs && s.repoName ? `${s.repoNs}/${s.repoName}` : "(unknown repo)";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  return (
    <div className="space-y-5">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {[...groups.entries()].map(([repoSlug, items]) => (
        <section key={repoSlug} className="space-y-2">
          <div className="flex items-center gap-2">
            <Link href={`/agents/standing?repo=${encodeURIComponent(repoSlug)}`} className="text-sm font-mono font-medium hover:text-primary">{repoSlug}</Link>
            <Badge variant="secondary" className="text-xs">{items.length}</Badge>
          </div>
          <div className="rounded-lg border bg-card divide-y">
            {items.map(s => {
              const autoPaused = !s.enabled && s.status === "error";
              return (
                <div key={s.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{s.name}</span>
                      {autoPaused ? <Badge variant="destructive" className="gap-1 text-[10px]"><AlertTriangle className="h-3 w-3" /> auto-paused</Badge>
                        : !s.enabled ? <Badge variant="secondary" className="text-[10px]">paused</Badge>
                        : <Badge className="bg-primary/15 text-primary border border-primary/30 text-[10px]">{s.status}</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{triggerLabel(s)} · <span className="font-mono">{s.mode ?? "worker"}</span> · <span className="font-mono">{s.llmProvider}</span></div>
                    {s.lastError && <div className="flex items-center gap-1 text-xs text-destructive mt-1"><AlertTriangle className="h-3 w-3" /> {s.lastError}</div>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="ghost" size="sm" title="Run now" disabled={busy === s.id || !s.repoNs} onClick={() => act(s, () => api.runStandingAgent(s.repoNs!, s.repoName!, s.id))}><Play className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" title={s.enabled ? "Pause" : "Resume"} disabled={busy === s.id || !s.repoNs} onClick={() => act(s, () => api.updateStandingAgent(s.repoNs!, s.repoName!, s.id, { enabled: !s.enabled }))}>{s.enabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 text-primary" />}</Button>
                    <Button variant="ghost" size="sm" title="Remove" disabled={busy === s.id || !s.repoNs} onClick={() => { if (window.confirm(`Remove standing agent ${s.name} from ${repoSlug}?`)) void act(s, () => api.deleteStandingAgent(s.repoNs!, s.repoName!, s.id)); }}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {rows.some(s => !s.repoNs) && <Card><CardContent className="pt-4 text-xs text-muted-foreground">Some agents&apos; repos couldn&apos;t be resolved; open the repo directly to manage them.</CardContent></Card>}
    </div>
  );
}
