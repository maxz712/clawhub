"use client";

import { useEffect, useState, use } from "react";
import { api, type Agent, type AgentQuota, type AgentUsageRow, type Risk } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [quota, setQuota] = useState<AgentQuota | null>(null);
  const [usage, setUsage] = useState<AgentUsageRow[]>([]);

  useEffect(() => {
    api.listAgents()
      .then(r => setAgent(r.agents.find(a => a.id === id) ?? null))
      .catch(e => setError((e as Error).message));
    api.getQuota(id).then(r => setQuota(r.quota)).catch(() => {});
    api.getAgentUsage(id).then(r => setUsage(r.usage)).catch(() => {});
  }, [id]);

  async function rotate() {
    try { const r = await api.rotateAgentToken(id); setNewToken(r.token); }
    catch (e) { setError((e as Error).message); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!agent) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-3xl font-bold tracking-tight font-mono">{agent.name}</h1>
      <Card>
        <CardHeader><CardTitle className="text-sm">Identity</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div><span className="text-muted-foreground">Git author:</span> <code className="font-mono">{agent.gitAuthorName} &lt;{agent.gitAuthorEmail}&gt;</code></div>
          <div><span className="text-muted-foreground">Capabilities:</span> {agent.capabilities.push ? "push" : "—"} {agent.capabilities.review ? "· review" : ""}</div>
          <div><span className="text-muted-foreground">Since:</span> {new Date(agent.createdAt).toLocaleDateString()}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Activity</CardTitle></CardHeader>
        <CardContent className="text-sm grid grid-cols-2 gap-4">
          <div><div className="text-3xl font-bold text-primary">{agent.stats.changesOpened}</div><div className="text-muted-foreground text-xs">changes opened</div></div>
          <div><div className="text-3xl font-bold text-primary">{agent.stats.reviewsSubmitted}</div><div className="text-muted-foreground text-xs">reviews submitted</div></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Token</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {newToken && (
            <div>
              <p className="text-sm">New token — save now, won&apos;t be shown again:</p>
              <code className="block p-2 bg-muted rounded font-mono text-xs break-all mt-1">{newToken}</code>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={rotate}>Rotate token</Button>
        </CardContent>
      </Card>

      {quota && <QuotaCard quota={quota} agentId={id} onChange={setQuota} />}

      <Card>
        <CardHeader><CardTitle className="text-sm">Recent usage</CardTitle></CardHeader>
        <CardContent className="text-xs font-mono space-y-1">
          {usage.length === 0 && <div className="text-muted-foreground">No usage recorded yet.</div>}
          {usage.slice(0, 20).map(u => (
            <div key={u.id} className="grid grid-cols-[auto_auto_1fr_auto] gap-3">
              <span>{u.window}</span>
              <span className="text-muted-foreground">{u.kind}</span>
              <span />
              <span className="font-bold">{u.count}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Public surface</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          {agent && (
            <>
              <div>Share URL: <a className="font-mono text-primary hover:underline" href={`/u/${agent.name}`}>/u/{agent.name}</a></div>
              <div>
                Badge:
                <pre className="text-xs bg-muted/40 border border-border p-2 rounded mt-1 overflow-x-auto">
{`![ClawHub agent](${api.agentBadgeUrl(agent.name)})`}
                </pre>
              </div>
              <img src={api.agentOgUrl(agent.name)} alt="Agent preview" className="rounded border border-border w-full" />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QuotaCard({ quota, agentId, onChange }: { quota: AgentQuota; agentId: string; onChange: (q: AgentQuota) => void }) {
  const [form, setForm] = useState(quota);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await api.updateQuota(agentId, {
        pushPerHour: form.pushPerHour,
        reviewPerHour: form.reviewPerHour,
        apiPerHour: form.apiPerHour,
        maxLocPerChange: form.maxLocPerChange,
        pathAllowlist: form.pathAllowlist,
        pathDenylist: form.pathDenylist,
        riskCeiling: form.riskCeiling,
      });
      onChange(r.quota);
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Quotas &amp; scope</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Push / hr</Label><Input type="number" value={form.pushPerHour} onChange={e => setForm({ ...form, pushPerHour: Number(e.target.value) })} /></div>
          <div><Label>Review / hr</Label><Input type="number" value={form.reviewPerHour} onChange={e => setForm({ ...form, reviewPerHour: Number(e.target.value) })} /></div>
          <div><Label>API / hr</Label><Input type="number" value={form.apiPerHour} onChange={e => setForm({ ...form, apiPerHour: Number(e.target.value) })} /></div>
          <div><Label>Max LOC / change</Label><Input type="number" value={form.maxLocPerChange} onChange={e => setForm({ ...form, maxLocPerChange: Number(e.target.value) })} /></div>
        </div>
        <div>
          <Label>Risk ceiling</Label>
          <Select value={form.riskCeiling} onValueChange={v => setForm({ ...form, riskCeiling: (v ?? "critical") as Risk })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {(["low", "medium", "high", "critical"] as Risk[]).map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label>Path allowlist (one glob per line, empty = all)</Label>
          <textarea
            className="w-full font-mono text-xs border border-border rounded p-2 bg-background"
            rows={3}
            value={form.pathAllowlist.join("\n")}
            onChange={e => setForm({ ...form, pathAllowlist: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
          />
        </div>
        <div>
          <Label>Path denylist</Label>
          <textarea
            className="w-full font-mono text-xs border border-border rounded p-2 bg-background"
            rows={3}
            value={form.pathDenylist.join("\n")}
            onChange={e => setForm({ ...form, pathDenylist: e.target.value.split("\n").map(s => s.trim()).filter(Boolean) })}
          />
        </div>
        <Button onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
      </CardContent>
    </Card>
  );
}
