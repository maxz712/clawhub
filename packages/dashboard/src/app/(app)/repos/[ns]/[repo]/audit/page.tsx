"use client";

import { use, useEffect, useState } from "react";
import { api, type AuditEvent } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const CATEGORIES = ["all", "auth", "repo", "change", "review", "merge", "issue", "agent", "secret", "ci", "release", "webhook", "policy", "admin", "other"];

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
          <h1 className="text-2xl font-bold tracking-tight font-mono">Audit log</h1>
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
              <div key={e.id} className="grid grid-cols-[auto_auto_auto_1fr_auto] items-center gap-3 py-2">
                <Badge variant="outline">{e.category}</Badge>
                <span>{e.action}</span>
                <span className="text-muted-foreground">{e.actorKind}</span>
                <pre className="truncate text-muted-foreground">{JSON.stringify(e.metadata)}</pre>
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
