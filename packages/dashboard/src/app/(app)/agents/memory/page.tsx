"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo, type MemoryWithRepo, type MemoryKind } from "@/lib/api";
import { MemoryView } from "@/components/memory-view";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Pin, PinOff, Archive, ArchiveRestore, Brain, Bot } from "lucide-react";

const ALL = "__all";

const KINDS: Array<{ key: MemoryKind | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "convention", label: "Conventions" },
  { key: "decision", label: "Decisions" },
  { key: "failure", label: "Failures" },
  { key: "expertise", label: "Expertise" },
  { key: "episode", label: "Episodes" },
];
const KIND_STYLE: Record<string, string> = {
  decision: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  convention: "bg-primary/15 text-primary border-primary/30",
  failure: "bg-red-500/15 text-red-400 border-red-500/30",
  expertise: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  episode: "bg-muted text-muted-foreground border-border",
};

// Agent memory in the one Agents hub. Defaults to a cross-repo "All repos" view
// (every memory the caller's agents accrued, grouped by repo); pick a repo for
// the full per-repo MemoryView (scope legend, etc). Same per-repo supervise API.
export default function HubMemoryPage() {
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
          <h1 className="text-3xl font-bold tracking-tight">Memory</h1>
          <p className="text-sm text-muted-foreground mt-1">What your agents have learned, across repos. Agents write it; you supervise — pin what matters, archive what&apos;s wrong. ClawHub ranks and decays it, never writes it.</p>
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
            No repos yet. Agent memory accrues per repo — <Link href="/repos" className="text-primary hover:underline">create or import one</Link> first.
          </div>
        ) : selected === ALL ? (
          <AllMemory />
        ) : ns && repo ? (
          <MemoryView ns={ns} repo={repo} />
        ) : null}
    </div>
  );
}

// Cross-repo memory roster: every live memory the caller's agents accrued,
// grouped by repo. Supervise (pin/archive) routes back to each row's own repo.
function AllMemory() {
  const [rows, setRows] = useState<MemoryWithRepo[] | null>(null);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try { const r = await api.listMyMemory({ kind: kind === "all" ? undefined : kind, archived }); setRows(r.memories); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [kind, archived]);

  async function act(m: MemoryWithRepo, action: "pin" | "unpin" | "archive" | "unarchive") {
    if (!m.repoNs || !m.repoName) return;
    try { await api.superviseMemory(m.repoNs, m.repoName, m.id, action); await load(); } catch (e) { setError((e as Error).message); }
  }

  const groups = new Map<string, MemoryWithRepo[]>();
  for (const m of rows ?? []) {
    const key = m.repoNs && m.repoName ? `${m.repoNs}/${m.repoName}` : "(unknown repo)";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 flex-wrap">
        {KINDS.map(k => (
          <Button key={k.key} size="sm" variant={kind === k.key ? "default" : "secondary"} onClick={() => setKind(k.key)}>{k.label}</Button>
        ))}
        <div className="flex-1" />
        <Button size="sm" variant={archived ? "default" : "ghost"} onClick={() => setArchived(a => !a)}>{archived ? "Showing archived" : "Show archived"}</Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {rows === null ? <div className="text-sm text-muted-foreground">Loading…</div>
        : rows.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            <Brain className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <div className="text-sm">No memories yet. A standing agent accrues them as it runs across your repos.</div>
          </div>
        ) : (
          <div className="space-y-6">
            {[...groups.entries()].map(([repoSlug, items]) => (
              <section key={repoSlug} className="space-y-2">
                <div className="flex items-center gap-2">
                  <Link href={`/agents/memory?repo=${encodeURIComponent(repoSlug)}`} className="text-sm font-mono font-medium hover:text-primary">{repoSlug}</Link>
                  <Badge variant="secondary" className="text-xs">{items.length}</Badge>
                </div>
                <div className="space-y-2">
                  {items.map(m => (
                    <div key={m.id} className={`rounded-lg border bg-card p-3 ${m.archivedAt ? "opacity-60" : ""}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={KIND_STYLE[m.kind]}>{m.kind}</Badge>
                            {m.pinned && <Badge className="bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 gap-1"><Pin className="h-3 w-3" /> pinned</Badge>}
                            {m.agentName && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Bot className="h-3 w-3" /> <span className="font-mono">{m.agentName}</span></span>}
                            <span className="text-xs text-muted-foreground">importance {m.importance} · used {m.useCount}×</span>
                          </div>
                          <div className="font-medium mt-1">{m.title}</div>
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap mt-0.5 line-clamp-4">{m.body}</p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="sm" title={m.pinned ? "Unpin" : "Pin"} disabled={!m.repoNs} onClick={() => act(m, m.pinned ? "unpin" : "pin")}>{m.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</Button>
                          <Button variant="ghost" size="sm" title={m.archivedAt ? "Restore" : "Archive (veto)"} disabled={!m.repoNs} onClick={() => act(m, m.archivedAt ? "unarchive" : "archive")}>{m.archivedAt ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
    </div>
  );
}
