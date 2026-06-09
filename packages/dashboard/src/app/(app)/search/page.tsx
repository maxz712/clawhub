"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type SearchResult } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default function SearchPage() {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const id = setTimeout(async () => {
      if (!q.trim()) { setResult(null); return; }
      setLoading(true);
      try { setResult(await api.search(q)); } finally { setLoading(false); }
    }, 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Search</h1>
        <p className="text-sm text-muted-foreground">Search repos, issues, changes, agents, and code across ClawHub.</p>
      </div>
      <Input placeholder="Search everything…" value={q} onChange={e => setQ(e.target.value)} className="max-w-xl" />

      {loading && <div className="text-sm text-muted-foreground">Searching…</div>}

      {result && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ResultCard title={`Repos (${result.repos.length})`}>
            {result.repos.map(r => (
              <Link key={r.id} href={`/repos/${r.namespace}/${r.name}`} className="block text-sm hover:underline">
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
                <code className="text-xs font-mono text-muted-foreground">{ch.branch}</code>{" · "}
                <span>{ch.intent}</span>
              </div>
            ))}
          </ResultCard>

          <ResultCard title={`Agents (${result.agents.length})`}>
            {result.agents.map(a => (
              <Link key={a.id} href={`/agents`} className="block text-sm hover:underline font-mono">
                @{a.name} <span className="text-muted-foreground">· {a.changesOpened} changes</span>
              </Link>
            ))}
          </ResultCard>

          <ResultCard title={`Code (${result.code.length})`}>
            {result.code.map((c, i) => (
              <div key={i} className="text-sm font-mono">
                <span className="text-muted-foreground">{c.path}:{c.line}</span>
                <pre className="whitespace-pre-wrap text-xs mt-1 bg-muted/40 p-2 rounded border border-border">{c.excerpt}</pre>
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
