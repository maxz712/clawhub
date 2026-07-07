"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type BlastRadius, type OrgRow } from "@/lib/api";
import { displayBranch } from "@/lib/branch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type OpsAgent = { id: string; name: string };
const PERSONAL = "__personal__";

export default function OpsPage() {
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [scope, setScope] = useState<string>(PERSONAL);
  const [agents, setAgents] = useState<OpsAgent[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [report, setReport] = useState<BlastRadius | null>(null);
  const [hours, setHours] = useState("24");
  const [killed, setKilled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.listOrgs().then(r => setOrgs(r.orgs)).catch(() => setOrgs([])); }, []);

  // Destructive levers (kill / release / bulk-rollback) follow the SERVER's
  // authorization: the agent's OWNER always governs their own agent (the solo
  // persona's core incident lever), and an ORG fleet's agents need an org admin.
  // So: allow PERSONAL scope (api.listAgents = the caller's own agents,
  // all owner-governed) OR an org scope the caller administers. Blast radius
  // (read-only) stays visible in every scope.
  const canOperate = scope === PERSONAL || orgs.some(o => o.id === scope && o.role === "admin");

  // Personal scope shows the caller's OWN agents (api.listAgents). An org
  // scope loads the whole org FLEET (getOrgFleet) — including role-fanout /
  // standing-attach agents the caller doesn't own, which were
  // previously unselectable for kill / blast-radius / bulk-rollback.
  const loadAgents = useCallback(async (sc: string) => {
    setErr(null);
    try {
      if (sc === PERSONAL) {
        const r = await api.listAgents();
        setAgents(r.agents.map(a => ({ id: a.id, name: a.name })));
        const map: Record<string, boolean> = {};
        for (const a of r.agents) { try { map[a.id] = (await api.killSwitchStatus(a.id)).engaged; } catch { /* leave unknown */ } }
        setKilled(map);
      } else {
        const fleet = await api.getOrgFleet(sc);
        setAgents(fleet.agents.map(a => ({ id: a.agentId, name: a.name })));
        const map: Record<string, boolean> = {};
        for (const a of fleet.agents) map[a.agentId] = a.killed; // killed state comes back with the fleet
        setKilled(map);
      }
    } catch (e) { setErr((e as Error).message); setAgents([]); }
  }, []);

  useEffect(() => { void loadAgents(scope); setSelected(""); setReport(null); }, [scope, loadAgents]);

  // Resolve an agent id to its @handle from the agents already loaded for this
  // scope; fall back to the short id so we never crash or show a bare UUID.
  function agentLabel(agentId: string): string {
    const name = agents.find(a => a.id === agentId)?.name;
    return name ? `@${name}` : agentId;
  }

  async function engage(id: string) {
    const reason = prompt("Reason for suspending this agent?") ?? undefined;
    setBusy(true); setErr(null); setMsg(null);
    try { await api.engageKillSwitch(id, reason); await loadAgents(scope); setMsg(`Kill switch engaged for ${agentLabel(id)}.`); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  async function release(id: string) {
    setBusy(true); setErr(null); setMsg(null);
    try { await api.releaseKillSwitch(id); await loadAgents(scope); setMsg(`Kill switch released for ${agentLabel(id)}.`); }
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Incident ops</h1>
          <p className="text-sm text-muted-foreground">Kill switches, blast radius reports, bulk rollback for agent incidents.</p>
        </div>
        {orgs.length > 0 && (
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Scope</div>
            {/* "Personal agents" (default) or one entry per org. Base UI Select
                renders raw sentinel values — map via the function child. */}
            <Select value={scope} onValueChange={v => { if (v) setScope(v); }}>
              <SelectTrigger className="w-56">
                <SelectValue>{(v: string) => v === PERSONAL ? "Personal agents" : (orgs.find(o => o.id === v)?.displayName || orgs.find(o => o.id === v)?.name || "Org")}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONAL}>Personal agents</SelectItem>
                {orgs.map(o => <SelectItem key={o.id} value={o.id}>{o.displayName || o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {msg && <Alert><AlertDescription>{msg}</AlertDescription></Alert>}
      {err && <Alert variant="destructive"><AlertDescription>{err}</AlertDescription></Alert>}

      <Card>
        <CardHeader><CardTitle className="text-sm">{scope === PERSONAL ? "Personal agents" : "Org agents"}</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {agents.length === 0 && <div className="text-sm text-muted-foreground py-2">No agents in this scope.</div>}
          {agents.map(a => (
            <div key={a.id} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 py-2 border-b border-border">
              <div>
                <div className="font-mono font-semibold">@{a.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{a.id}</div>
              </div>
              {killed[a.id] ? <Badge variant="destructive">KILLED</Badge> : <Badge variant="secondary">live</Badge>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setSelected(a.id)}>Blast radius</Button>
              {canOperate
                ? (killed[a.id]
                  ? <Button size="sm" variant="outline" disabled={busy} onClick={() => release(a.id)}>Release</Button>
                  : <Button size="sm" variant="destructive" disabled={busy} onClick={() => engage(a.id)}>Kill</Button>)
                : <span />}
            </div>
          ))}
        </CardContent>
      </Card>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Blast radius — {agentLabel(selected)}</CardTitle>
            <div className="text-xs font-mono text-muted-foreground">{selected}</div>
          </CardHeader>
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
                      <div><span className="text-muted-foreground" title={c.branch}>{displayBranch(c.branch)}</span> · {c.intent}</div>
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
