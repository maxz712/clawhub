"use client";

import { use, useEffect, useState } from "react";
import { api, type AuditEvent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const CATEGORIES = ["all", "auth", "repo", "change", "review", "merge", "issue", "agent", "secret", "ci", "release", "webhook", "policy", "admin", "other"];

// Render the most useful metadata keys as readable chips; the full payload is
// available on expand rather than a single truncated JSON.stringify blob.
function MetadataCell({ metadata }: { metadata: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return <span className="text-muted-foreground/50">—</span>;
  const fmt = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v));
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1">
        {entries.slice(0, open ? entries.length : 3).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] max-w-[200px] truncate">
            <span className="text-muted-foreground">{k}</span>
            <span className="text-foreground truncate">{fmt(v)}</span>
          </span>
        ))}
        {entries.length > 3 && (
          <button onClick={() => setOpen(o => !o)} className="text-[10px] text-muted-foreground hover:text-foreground underline">
            {open ? "less" : `+${entries.length - 3} more`}
          </button>
        )}
      </div>
    </div>
  );
}

export default function AuditPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("all");

  useEffect(() => {
    void api.listAudit(ns, repo, category === "all" ? {} : { category }).then(r => {
      setEvents(r.events); setTotal(r.total);
    });
  }, [ns, repo, category]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Audit log</h1>
          <p className="text-sm text-muted-foreground">Every action on {ns}/{repo}. {total} total events.</p>
        </div>
        <Select value={category} onValueChange={v => setCategory(v ?? "all")}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent</CardTitle></CardHeader>
        <CardContent>
          <div className="divide-y divide-border font-mono text-xs">
            {events.length === 0 && <div className="text-muted-foreground py-4">No events.</div>}
            {events.map(e => (
              <div key={e.id} className="grid grid-cols-[auto_auto_auto_1fr_auto] items-start gap-3 py-2">
                <Badge variant="outline">{e.category}</Badge>
                <span>{e.action}</span>
                <span className="text-muted-foreground">{e.actorKind}</span>
                <MetadataCell metadata={e.metadata} />
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
