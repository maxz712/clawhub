"use client";

import { use, useEffect, useState } from "react";
import { api, type FlagRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function FlagsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [key, setKey] = useState("");

  async function load() { const r = await api.listRepoFlags(ns, repo); setFlags(r.flags); }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo]);

  async function create() {
    if (!key) return;
    await api.upsertRepoFlag(ns, repo, key, { enabled: false, rolloutPercent: 0 });
    setKey("");
    void load();
  }

  async function update(f: FlagRow, patch: { enabled?: boolean; rolloutPercent?: number }) {
    await api.upsertRepoFlag(ns, repo, f.key, patch);
    void load();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Feature flags</h1>
        <p className="text-sm text-muted-foreground">Percentage rollouts + rule overrides. Agents evaluate via <code className="font-mono text-xs">/api/v1/flags/evaluate</code>.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">New flag</CardTitle></CardHeader>
        <CardContent className="flex gap-2">
          <Input placeholder="new-focused-diff" value={key} onChange={e => setKey(e.target.value)} />
          <Button onClick={create}>Create</Button>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {flags.map(f => (
          <Card key={f.id}>
            <CardContent className="pt-4 grid grid-cols-[1fr_auto_auto] items-center gap-4">
              <div>
                <div className="font-mono font-semibold">{f.key}</div>
                <div className="text-xs font-mono text-muted-foreground">rollout: {f.rolloutPercent}%</div>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-xs">Rollout %</Label>
                <Input type="number" min={0} max={100} value={f.rolloutPercent} onChange={e => void update(f, { rolloutPercent: Math.max(0, Math.min(100, Number(e.target.value))) })} className="w-24" />
              </div>
              <Button variant={f.enabled ? "default" : "outline"} size="sm" onClick={() => void update(f, { enabled: !f.enabled })}>
                {f.enabled ? <Badge>on</Badge> : "off"}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
