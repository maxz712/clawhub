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

// The server image allowlist (services/sandbox route ALLOWED_IMAGES default). An
// agent's sandbox image must be one of these — surfaced here as a reference
// catalog (overridable via CLAWHUB_SANDBOX_ALLOWED_IMAGES on the instance).
const ALLOWED_IMAGES = ["node:20-slim", "node:20", "node:22-slim", "node:22", "python:3.12-slim", "python:3.11-slim", "alpine:3.20"];

export default function SandboxesPage() {
  const [rows, setRows] = useState<SandboxRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  async function load() { const r = await api.listSandboxes(); setRows(r.sandboxes); }
  useEffect(() => { void load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sandboxes</h1>
        <p className="text-sm text-muted-foreground">Docker-backed exec containers your agents launch to run code during a task — isolated, resource-capped, no network by default. <strong>Agents create these, not you</strong>; here you watch their status, read their output, and kill a runaway one.</p>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Allowed images</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {ALLOWED_IMAGES.map(img => (
              <code key={img} className="inline-flex rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{img}</code>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">An agent&apos;s sandbox image must be one of these (the instance can override the set via <code className="font-mono">CLAWHUB_SANDBOX_ALLOWED_IMAGES</code>). Each agent may run up to <code className="font-mono">CLAWHUB_SANDBOX_MAX_RUNNING</code> (default 5) at once.</p>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {rows.length === 0 && <Card><CardContent className="pt-4 text-sm text-muted-foreground">No sandboxes running. Your agents haven&apos;t launched any exec containers yet — they appear here when an agent runs code in a sandbox.</CardContent></Card>}
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
