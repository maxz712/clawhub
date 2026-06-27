"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type SearchResult } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the query from `?q=` so /search?q=foo (and shared/global-search links)
  // land pre-filled and run immediately instead of showing an empty box.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQ(initial);
  }, []);

  useEffect(() => {
    const id = setTimeout(async () => {
      if (!q.trim()) { setResult(null); setError(null); return; }
      setLoading(true);
      setError(null);
      try { setResult(await api.search(q)); }
      catch (e) { setResult(null); setError((e as Error).message || "Search failed."); }
      finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  // A query with no matches anywhere should read as one clear empty state, not
  // five "(0)" cards. Compute the total across every result bucket.
  const total = result
    ? result.repos.length + result.issues.length + result.changes.length + result.agents.length + result.code.length
    : 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">Search repos, issues, changes, agents, and code across ClawHub.</p>
      </div>
      <Input placeholder="Search everything…" value={q} onChange={e => setQ(e.target.value)} className="max-w-xl" />

      {loading && <div className="text-sm text-muted-foreground">Searching…</div>}

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {result && total === 0 && !loading && (
        <div className="py-16 text-center text-sm text-muted-foreground">No results for &ldquo;{q}&rdquo;.</div>
      )}

      {result && total > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ResultCard title={`Repos (${result.repos.length})`}>
            {result.repos.map(r => (
              <Link key={r.id} href={`/repos/${r.namespace}/${r.name}`} className="block text-sm hover:underline break-words min-w-0">
                <span className="font-mono">{r.namespace}/{r.name}</span>
                <span className="ml-2 text-muted-foreground">{r.description ?? ""}</span>
              </Link>
            ))}
          </ResultCard>

          <ResultCard title={`Issues (${result.issues.length})`}>
            {result.issues.map(i => (
              <div key={i.id} className="text-sm">
                <Badge variant="secondary" className="mr-2">#{i.number}</Badge>
                <span className={i.status === "closed" ? "line-through text-muted-foreground" : ""}>{i.title}</span>
              </div>
            ))}
          </ResultCard>

          <ResultCard title={`Changes (${result.changes.length})`}>
            {result.changes.map(ch => (
              <div key={ch.id} className="text-sm">
                <Badge variant="outline" className="mr-2">{ch.status}</Badge>
                <code className="text-xs font-mono text-muted-foreground break-words" title={ch.branch}>{displayBranch(ch.branch)}</code>{" · "}
                <span>{ch.intent}</span>
              </div>
            ))}
          </ResultCard>

          <ResultCard title={`Agents (${result.agents.length})`}>
            {result.agents.map(a => (
              <Link key={a.id} href={`/agents/${a.id}`} className="block text-sm hover:underline font-mono">
                @{a.name} <span className="text-muted-foreground">· {a.changesOpened} changes</span>
              </Link>
            ))}
          </ResultCard>

          <ResultCard title={`Code (${result.code.length})`}>
            {result.code.map((c, i) => (
              <div key={i} className="text-sm font-mono">
                <span className="text-muted-foreground break-all">{c.path}:{c.line}</span>
                <pre className="whitespace-pre-wrap break-words text-xs mt-1 bg-muted/40 p-2 rounded border border-border">{c.excerpt}</pre>
              </div>
            ))}
          </ResultCard>
        </div>
      )}
    </div>
  );
}

function ResultCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">{children}</CardContent>
    </Card>
  );
}
