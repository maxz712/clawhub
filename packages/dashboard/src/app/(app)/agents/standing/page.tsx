"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo, type StandingAgentWithRepo } from "@/lib/api";
import { StandingAgentsPanel } from "@/components/standing-agents-panel";
import { StandingAgentRow } from "@/components/standing-agent-row";
import { AttachStandingAgentDialog } from "@/components/attach-standing-agent-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Bot, Plus } from "lucide-react";

const ALL = "__all";

// Standing agents — bring-your-own-AI agents ClawHub runs 24/7 on a repo —
// surfaced in the one Agents hub. Defaults to a cross-repo "All repos" roster;
// pick a repo for the full per-repo panel. You can attach a new one from either.
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Standing agents</h1>
          <p className="text-sm text-muted-foreground mt-1">Bring-your-own-AI agents ClawHub runs on a schedule, continuously, or on events — across all your repos, or pick one.</p>
        </div>
        {repos && repos.length > 0 && (
          <div className="min-w-56">
            <Label className="text-xs text-muted-foreground">Repo</Label>
            <Select value={selected} onValueChange={v => { if (v) setSelected(v); }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick a repo">{(v: string) => v === ALL ? "All repos" : v}</SelectValue></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All repos</SelectItem>
                {repos.map(r => { const slug = `${r.namespaceName}/${r.name}`; return <SelectItem key={r.id} value={slug}>{slug}</SelectItem>; })}
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
          <AllStandingAgents repos={repos} />
        ) : ns && repo ? (
          <StandingAgentsPanel ns={ns} repo={repo} />
        ) : null}
    </div>
  );
}

// Cross-repo roster: every standing agent the caller governs, grouped by repo,
// rendered with the SAME StandingAgentRow as the per-repo panel. "Attach agent"
// opens the dialog with a repo picker so creating one never needs a drill-in.
function AllStandingAgents({ repos }: { repos: Repo[] }) {
  const [rows, setRows] = useState<StandingAgentWithRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attach, setAttach] = useState(false);

  async function load() {
    try { const r = await api.listMyStandingAgents(); setRows(r.standingAgents); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);

  const groups = new Map<string, StandingAgentWithRepo[]>();
  for (const s of rows ?? []) {
    const key = s.repoNs && s.repoName ? `${s.repoNs}/${s.repoName}` : "(unknown repo)";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{rows ? `${rows.length} across ${groups.size} repo${groups.size === 1 ? "" : "s"}` : "Loading…"}</div>
        <Button size="sm" className="gap-2" onClick={() => setAttach(true)}><Plus className="h-4 w-4" /> Attach agent</Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {rows === null ? <div className="text-sm text-muted-foreground">Loading…</div>
        : rows.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            <Bot className="h-7 w-7 mx-auto mb-2 opacity-40" />
            <div>No standing agents yet.</div>
            <Button size="sm" variant="outline" className="mt-3 gap-2" onClick={() => setAttach(true)}><Plus className="h-4 w-4" /> Attach one</Button>
          </div>
        ) : (
          [...groups.entries()].map(([repoSlug, items]) => (
            <section key={repoSlug} className="space-y-2">
              <div className="flex items-center gap-2">
                <Link href={`/agents/standing?repo=${encodeURIComponent(repoSlug)}`} className="text-sm font-mono font-medium hover:text-primary">{repoSlug}</Link>
                <Badge variant="secondary" className="text-xs">{items.length}</Badge>
              </div>
              <div className="rounded-lg border bg-card divide-y">
                {items.map(s => <StandingAgentRow key={s.id} ns={s.repoNs ?? ""} repo={s.repoName ?? ""} agent={s} onChanged={load} />)}
              </div>
            </section>
          ))
        )}

      <AttachStandingAgentDialog open={attach} onOpenChange={setAttach} onAttached={load} repos={repos} />
    </div>
  );
}
