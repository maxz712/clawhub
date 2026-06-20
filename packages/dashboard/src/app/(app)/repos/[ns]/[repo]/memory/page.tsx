"use client";

import { useEffect, useState, use } from "react";
import { api, type Memory, type MemoryKind } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Pin, PinOff, Archive, ArchiveRestore, Brain } from "lucide-react";

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

export default function MemoryPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [kind, setKind] = useState<MemoryKind | "all">("all");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try { const r = await api.listMemory(ns, repo, { kind: kind === "all" ? undefined : kind, archived }); setMemories(r.memories); setError(null); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [ns, repo, kind, archived]);

  async function act(id: string, action: "pin" | "unpin" | "archive" | "unarchive") {
    try { await api.superviseMemory(ns, repo, id, action); await load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Brain className="h-6 w-6 text-primary" /> Memory</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What agents have learned about <code className="font-mono">{ns}/{repo}</code> across runs. Agents write these; you supervise —
          pin what matters, archive what&apos;s wrong. ClawHub ranks and decays them; it never wrote them.
        </p>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex items-center gap-2 flex-wrap">
        {KINDS.map(k => (
          <Button key={k.key} size="sm" variant={kind === k.key ? "default" : "secondary"} onClick={() => setKind(k.key)}>{k.label}</Button>
        ))}
        <div className="flex-1" />
        <Button size="sm" variant={archived ? "default" : "ghost"} onClick={() => setArchived(a => !a)}>{archived ? "Showing archived" : "Show archived"}</Button>
      </div>

      {memories === null ? <div className="text-muted-foreground text-sm">Loading…</div>
        : memories.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
            <Brain className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <div className="text-sm">No memories yet. A standing agent accrues them as it runs — conventions it learns, failures it fixes, decisions it makes.</div>
          </div>
        ) : (
          <div className="space-y-2">
            {memories.map(m => (
              <div key={m.id} className={`rounded-lg border bg-card p-3 ${m.archivedAt ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={KIND_STYLE[m.kind]}>{m.kind}</Badge>
                      {m.pinned && <Badge className="bg-yellow-500/15 text-yellow-500 border border-yellow-500/30 gap-1"><Pin className="h-3 w-3" /> pinned</Badge>}
                      <span className="text-xs text-muted-foreground">importance {m.importance} · used {m.useCount}× · <span className="font-mono">{m.scope}</span></span>
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
            ))}
          </div>
        )}
    </div>
  );
}
