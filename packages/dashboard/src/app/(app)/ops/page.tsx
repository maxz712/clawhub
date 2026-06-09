"use client";

import { useEffect, useState } from "react";
import { api, type Agent, type BlastRadius } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";

export default function OpsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<BlastRadius | null>(null);
  const [hours, setHours] = useState("24");
  const [killed, setKilled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadAgents() {
    const r = await api.listAgents();
    setAgents(r.agents);
    const map: Record<string, boolean> = {};
    for (const a of r.agents) {
      try { const s = await api.killSwitchStatus(a.id); map[a.id] = s.engaged; } catch {}
    }
    setKilled(map);
  }

  useEffect(() => { void loadAgents(); }, []);

  async function engage(id: string) {
    const reason = prompt("Reason for suspending this agent?") ?? undefined;
    setBusy(true); setErr(null); setMsg(null);
    try { await api.engageKillSwitch(id, reason); await loadAgents(); setMsg(`Kill switch engaged for ${id}.`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function release(id: string) {
    setBusy(true); setErr(null); setMsg(null);
    try { await api.releaseKillSwitch(id); await loadAgents(); setMsg(`Kill switch released for ${id}.`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  async function loadReport() {
    if (!selected) return;
    const r = await api.blastRadius(selected, Number(hours));
    setReport(r.report);
  }

  async function bulkRevert() {
    if (!report) return;
    const ids = report.changesMerged.map(c => c.id);
    if (ids.length === 0) return;
    if (!confirm(`Rollback ${ids.length} merged change(s)?`)) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.bulkRollback(report.agentId, ids);
      setMsg(`Rolled back ${r.rolled.length} / ${ids.length}. ${r.failed.length} failed.`);
      await loadReport();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight font-mono">Incident ops</h1>
        <p className="text-sm text-muted-foreground">Kill switches, blast radius reports, bulk rollback for agent incidents.</p>
      </div>

      {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">Agents</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {agents.map(a => (
            <div key={a.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 py-2 border-b border-border">
              <div>
                <div className="font-mono font-semibold">@{a.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{a.id}</div>
              </div>
              {killed[a.id] ? <Badge variant="destructive">KILLED</Badge> : <Badge variant="secondary">live</Badge>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected(a.id)}>Blast radius</Button>
              {killed[a.id]
                ? <Button size="sm" variant="outline" disabled={busy} onClick={() => release(a.id)}>Release</Button>
                : <Button size="sm" variant="destructive" disabled={busy} onClick={() => engage(a.id)}>Kill</Button>}
            </div>
          ))}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Blast radius — {selected}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2 items-center">
              <label className="text-sm">Hours:</label>
              <Input type="number" value={hours} onChange={e => setHours(e.target.value)} className="w-24" />
              <Button size="sm" onClick={loadReport}>Load</Button>
              {report && report.changesMerged.length > 0 && (
                <Button size="sm" variant="destructive" onClick={bulkRevert} disabled={busy}>Rollback all merged ({report.changesMerged.length})</Button>
              )}
            </div>
            {report && (
              <div className="text-sm space-y-2">
                <div className="flex gap-4 flex-wrap">
                  <Badge>opened: {report.changesOpened.length}</Badge>
                  <Badge>merged: {report.changesMerged.length}</Badge>
                  <Badge>reviews: {report.reviewsSubmitted}</Badge>
                  <Badge>comments: {report.commentsAuthored}</Badge>
                  <Badge>repos: {report.reposTouched.length}</Badge>
                </div>
                <div className="space-y-1 font-mono text-xs">
                  {report.changesMerged.map(c => (
                    <div key={c.id} className="p-2 bg-muted/40 border border-border rounded">
                      <div><span className="text-muted-foreground">{c.branch}</span> · {c.intent}</div>
                      <div className="text-muted-foreground">merged: {c.mergedAt ? new Date(c.mergedAt).toLocaleString() : ""} {c.mergeCommit ? `· ${c.mergeCommit.slice(0, 7)}` : ""}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
