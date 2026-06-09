"use client";

import { useEffect, useState } from "react";
import { api, type SandboxRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "finished") return "default";
  if (s === "running") return "secondary";
  if (s === "failed" || s === "killed") return "destructive";
  return "outline";
}

export default function SandboxesPage() {
  const [rows, setRows] = useState<SandboxRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  async function load() { const r = await api.listSandboxes(); setRows(r.sandboxes); }
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sandboxes</h1>
        <p className="text-sm text-muted-foreground">Docker-backed exec for agents. Launch via <code className="font-mono text-xs">POST /api/v1/sandbox</code>.</p>
      </div>

      <div className="space-y-2">
        {rows.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">No sandboxes yet.</CardContent></Card>}
        {rows.map(s => (
          <Card key={s.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                <code className="font-mono text-xs">{s.image}</code>
                <span className="text-xs font-mono text-muted-foreground truncate max-w-xl">{s.command}</span>
                <div className="flex-1" />
                {s.status === "running" && <Button size="sm" variant="destructive" onClick={async () => { await api.killSandbox(s.id); void load(); }}>Kill</Button>}
                <Button size="sm" variant="outline" onClick={() => setOpen(open === s.id ? null : s.id)}>{open === s.id ? "Hide" : "Logs"}</Button>
              </CardTitle>
            </CardHeader>
            {open === s.id && (
              <CardContent className="space-y-2">
                <div className="text-xs font-mono text-muted-foreground">exit: {s.exitCode ?? "—"} · started: {s.startedAt ? new Date(s.startedAt).toLocaleString() : "—"} · finished: {s.finishedAt ? new Date(s.finishedAt).toLocaleString() : "—"}</div>
                {s.stdout && (<div><div className="text-xs font-mono text-muted-foreground">stdout</div><pre className="text-xs bg-muted/40 p-2 rounded border border-border overflow-x-auto">{s.stdout}</pre></div>)}
                {s.stderr && (<div><div className="text-xs font-mono text-red-400">stderr</div><pre className="text-xs bg-red-950/20 text-red-200 p-2 rounded border border-red-900/40 overflow-x-auto">{s.stderr}</pre></div>)}
              </CardContent>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
