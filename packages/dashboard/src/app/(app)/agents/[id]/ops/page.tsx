"use client";

import { use, useEffect, useState } from "react";
import { api, type AgentVersionRow, type CostEntryRow, type EvalRunRow, type QualityScoreRow } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default function AgentOpsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [quality, setQuality] = useState<QualityScoreRow | null>(null);
  const [versions, setVersions] = useState<AgentVersionRow[]>([]);
  const [runs, setRuns] = useState<EvalRunRow[]>([]);
  const [cost, setCost] = useState<{ entries: CostEntryRow[]; monthCents: number } | null>(null);
  const [newVersion, setNewVersion] = useState("");

  async function load() {
    const [q, v, r, c] = await Promise.all([
      api.agentQuality(id).catch(() => null),
      api.listAgentVersions(id).catch(() => ({ versions: [] })),
      api.agentEvalRuns(id).catch(() => ({ runs: [] })),
      api.agentCost(id).catch(() => null),
    ]);
    if (q) setQuality(q.quality);
    setVersions(v.versions);
    setRuns(r.runs);
    if (c) setCost(c);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function recompute() { const r = await api.recomputeAgentQuality(id); setQuality(r.quality); }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Agent ops · {id.slice(0, 8)}</h1>
      </div>

      <Tabs defaultValue="quality">
        <TabsList>
          <TabsTrigger value="quality">Quality</TabsTrigger>
          <TabsTrigger value="versions">Versions ({versions.length})</TabsTrigger>
          <TabsTrigger value="evals">Evals ({runs.length})</TabsTrigger>
          <TabsTrigger value="cost">Cost</TabsTrigger>
        </TabsList>

        <TabsContent value="quality" className="space-y-3 pt-4">
          {!quality && <div className="text-sm text-muted-foreground">No quality score computed yet.</div>}
          {quality && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <Stat label="Merge rate" value={`${quality.mergeRate}%`} accent="var(--primary)" />
              <Stat label="Revert rate" value={`${quality.revertRate}%`} accent="var(--destructive)" />
              <Stat label="TTG CI p50" value={`${Math.round(quality.timeToGreenCiP50 / 60)}m`} />
              <Stat label="Review hit" value={`${quality.reviewHitRate}%`} />
              <Stat label="Drift" value={`${quality.driftScore}`} />
            </div>
          )}
          <Button size="sm" onClick={recompute}>Recompute now</Button>
        </TabsContent>

        <TabsContent value="versions" className="space-y-2 pt-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Register new version</CardTitle></CardHeader>
            <CardContent className="flex gap-2">
              <Input placeholder="1.2.3" value={newVersion} onChange={e => setNewVersion(e.target.value)} />
              <Button onClick={async () => { if (!newVersion) return; await api.registerAgentVersion(id, { version: newVersion }); setNewVersion(""); void load(); }}>Register</Button>
            </CardContent>
          </Card>
          {versions.map(v => (
            <Card key={v.id}>
              <CardContent className="pt-4 flex items-center justify-between">
                <div>
                  <div className="font-mono font-semibold">v{v.version}</div>
                  <div className="text-xs font-mono text-muted-foreground">{v.modelName ?? "(no model)"} · {v.promptHash ?? ""}</div>
                </div>
                <div className="flex gap-2 items-center">
                  <Badge variant={v.trustTier === "trusted" ? "default" : v.trustTier === "standard" ? "secondary" : "outline"}>{v.trustTier}</Badge>
                  {(["untrusted", "sandbox", "standard", "trusted"] as const).map(t => (
                    <Button key={t} size="sm" variant="outline" disabled={v.trustTier === t} onClick={async () => { await api.promoteAgentTier(id, v.id, t); void load(); }}>{t}</Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="evals" className="space-y-2 pt-4">
          {runs.length === 0 && <div className="text-sm text-muted-foreground">No eval runs yet.</div>}
          {runs.map(r => (
            <Card key={r.id}>
              <CardContent className="pt-4 flex items-center gap-3">
                <Badge variant={r.status === "finished" ? "default" : r.status === "failed" ? "destructive" : "secondary"}>{r.status}</Badge>
                <span className="font-mono text-sm">score: {r.score ?? "—"}</span>
                <span className="text-xs font-mono text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</span>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="cost" className="space-y-3 pt-4">
          {cost && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <Stat label="This month" value={`$${(cost.monthCents / 100).toFixed(2)}`} accent="var(--primary)" />
              <Stat label="Entries" value={String(cost.entries.length)} />
              <Stat label="Avg / entry" value={`$${((cost.monthCents / 100) / Math.max(cost.entries.length, 1)).toFixed(2)}`} />
            </div>
          )}
          <div className="font-mono text-xs space-y-1">
            {cost?.entries.slice(0, 20).map(e => (
              <div key={e.id} className="grid grid-cols-[auto_1fr_auto_auto] gap-3 py-1 border-b border-border">
                <span className="text-muted-foreground">{new Date(e.createdAt).toLocaleDateString()}</span>
                <span className="truncate">{e.model ?? e.kind}</span>
                <span>{(e.inputTokens + e.outputTokens).toLocaleString()} tok</span>
                <span className="font-bold">${(e.costCents / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded border bg-card p-3">
      <div className="text-xs font-mono text-muted-foreground uppercase">{label}</div>
      <div className="text-2xl font-bold mt-1" style={{ color: accent ?? "inherit" }}>{value}</div>
    </div>
  );
}
