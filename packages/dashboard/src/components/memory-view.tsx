"use client";

import { useEffect, useState } from "react";
import { api, type Memory, type MemoryKind, type MemoryEdge } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pin, PinOff, Archive, ArchiveRestore, Brain, Bot, GitBranch, Users, Building2, ChevronDown, ChevronRight, Network, List } from "lucide-react";
import { MemoryGraphSvg } from "@/components/memory-graph-svg";

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

// The four memory scopes — the answer to "is memory per-agent or per-repo?": it's
// BOTH, on two axes. An agent's knowledge can be tied to itself, to a repo, to the
// pair, or shared org-wide. Ordered most-specific → most-shared.
const SCOPES: Array<{ key: string; label: string; blurb: string; icon: typeof Bot; cls: string }> = [
  { key: "agent_repo", label: "This agent · this repo", blurb: "What this agent learned about THIS repo. The default — repo-specific context for one agent.", icon: GitBranch, cls: "text-primary border-primary/40" },
  { key: "repo", label: "Shared on this repo", blurb: "Every agent working on this repo sees this. Repo conventions that aren't tied to one agent.", icon: Users, cls: "text-blue-400 border-blue-500/40" },
  { key: "agent", label: "This agent · everywhere", blurb: "Travels WITH the agent across every repo it works on. How one agent gets smarter globally.", icon: Bot, cls: "text-amber-400 border-amber-500/40" },
  { key: "org", label: "Org-wide", blurb: "Shared across the whole org (a supervised, human-promoted scope).", icon: Building2, cls: "text-violet-400 border-violet-500/40" },
];
const SCOPE_BY_KEY = Object.fromEntries(SCOPES.map(s => [s.key, s]));

// The repo-scoped agent-memory view. Used both by the repo's Memory tab and by
// the Agents hub Memory tab (behind a repo switcher) — one source of truth.
export function MemoryView({ ns, repo }: { ns: string; repo: string }) {
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scopeLegendOpen, setScopeLegendOpen] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [graph, setGraph] = useState<{ nodes: Memory[]; edges: MemoryEdge[] } | null>(null);

  async function load() {
    try { const r = await api.listMemory(ns, repo, { kind: kind === "all" ? undefined : kind, archived }); setMemories(r.memories); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [ns, repo, kind, archived]);
  useEffect(() => {
    if (view !== "graph") return;
    setGraph(null);
    api.getMemoryGraph(ns, repo, { kind: kind === "all" ? undefined : kind })
      .then(g => { setGraph(g); setError(null); })
      .catch(e => setError((e as Error).message));
  }, [view, ns, repo, kind]);

  async function act(id: string, action: "pin" | "unpin" | "archive" | "unarchive") {
    try { await api.superviseMemory(ns, repo, id, action); await load(); } catch (e) { setError((e as Error).message); }
  }

  // Group by scope, in the SCOPES order; unknown scopes fall to the end.
  const groups = SCOPES.map(s => ({ scope: s, items: (memories ?? []).filter(m => m.scope === s.key) }))
    .filter(g => g.items.length > 0);
  const ungrouped = (memories ?? []).filter(m => !SCOPE_BY_KEY[m.scope]);

  function card(m: Memory) {
    return (
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
            <Button variant="ghost" size="sm" title={m.pinned ? "Unpin" : "Pin"} onClick={() => act(m.id, m.pinned ? "unpin" : "pin")}>{m.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</Button>
            <Button variant="ghost" size="sm" title={m.archivedAt ? "Restore" : "Archive (veto)"} onClick={() => act(m.id, m.archivedAt ? "unarchive" : "archive")}>{m.archivedAt ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        What agents have learned about <code className="font-mono">{ns}/{repo}</code> across runs. Fills in once a standing agent runs — pin what matters, archive what&apos;s wrong.
      </p>

      {/* Scope legend — collapsed by default so it doesn't dominate; the per-agent
          vs per-repo model is one click away. */}
      <div className="rounded-lg border bg-card/50">
        <button
          onClick={() => setScopeLegendOpen(o => !o)}
          className="flex w-full items-center gap-1.5 p-3 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {scopeLegendOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          How memory is scoped
        </button>
        {scopeLegendOpen && (
          <div className="grid sm:grid-cols-2 gap-2 px-3 pb-3">
            {SCOPES.map(s => (
              <div key={s.key} className="flex items-start gap-2">
                <span className={`mt-0.5 inline-flex items-center justify-center rounded border ${s.cls} h-5 w-5 shrink-0`}><s.icon className="h-3 w-3" /></span>
                <div className="text-xs"><span className="font-medium">{s.label}</span> <span className="text-muted-foreground">— {s.blurb}</span></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex items-center gap-2 flex-wrap">
        {KINDS.map(k => (
          <Button key={k.key} size="sm" variant={kind === k.key ? "default" : "secondary"} onClick={() => setKind(k.key)}>{k.label}</Button>
        ))}
        <div className="flex-1" />
        {view === "list" && <Button size="sm" variant={archived ? "default" : "ghost"} onClick={() => setArchived(a => !a)}>{archived ? "Showing archived" : "Show archived"}</Button>}
        <div className="inline-flex rounded-md border overflow-hidden">
          <Button size="sm" variant={view === "list" ? "default" : "ghost"} className="rounded-none gap-1" onClick={() => setView("list")}><List className="h-3.5 w-3.5" /> List</Button>
          <Button size="sm" variant={view === "graph" ? "default" : "ghost"} className="rounded-none gap-1" onClick={() => setView("graph")}><Network className="h-3.5 w-3.5" /> Graph</Button>
        </div>
      </div>

      {view === "graph" && (graph === null ? <div className="text-muted-foreground text-sm">Loading…</div> : <MemoryGraphSvg nodes={graph.nodes} edges={graph.edges} />)}

      {view === "list" && (memories === null ? <div className="text-muted-foreground text-sm">Loading…</div>
        : memories.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            <Brain className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <div className="text-sm">No memories yet. A standing agent accrues them as it runs — conventions it learns, failures it fixes, decisions it makes.</div>
          </div>
        ) : (
          <div className="space-y-6">
            {groups.map(g => (
              <section key={g.scope.key} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center justify-center rounded border ${g.scope.cls} h-6 w-6`}><g.scope.icon className="h-3.5 w-3.5" /></span>
                  <h2 className="text-sm font-semibold">{g.scope.label}</h2>
                  <Badge variant="secondary" className="text-xs">{g.items.length}</Badge>
                </div>
                <div className="space-y-2">{g.items.map(card)}</div>
              </section>
            ))}
            {ungrouped.length > 0 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-muted-foreground">Other</h2>
                <div className="space-y-2">{ungrouped.map(card)}</div>
              </section>
            )}
          </div>
        ))}
    </div>
  );
}
