"use client";

import { useEffect, useState, use } from "react";
import { api, type AgentRoleRow, type OrgFleet } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Bot, Shield, Gauge, Boxes, Sparkles, Zap, Skull, Trash2 } from "lucide-react";

const CAP_ICON: Record<string, typeof Bot> = { worker: Bot, reviewer: Shield, triager: Boxes, specialist: Sparkles };
const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function FleetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: orgId } = use(params);
  const [fleet, setFleet] = useState<OrgFleet | null>(null);
  const [templates, setTemplates] = useState<AgentRoleRow[]>([]);
  const [roles, setRoles] = useState<AgentRoleRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<AgentRoleRow | null>(null);

  async function load() {
    try {
      const [f, t, r] = await Promise.all([api.getOrgFleet(orgId), api.listRoleTemplates(), api.listRoles(orgId)]);
      setFleet(f); setTemplates(t.templates); setRoles(r.roles); setError(null);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [orgId]);

  async function act(fn: () => Promise<unknown>) { setError(null); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Bot className="h-6 w-6 text-primary" /> Fleet</h1>
          <p className="text-sm text-muted-foreground mt-1">Every agent your org runs — roles, trust, quality, cost, kill — in one pane.</p>
        </div>
        {fleet && <div className="text-right"><div className="text-xs text-muted-foreground">spend this month</div><div className="text-xl font-bold">{fmtCents(fleet.orgSpendCents)}</div></div>}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      {/* Deploy a role from a template */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Deploy a role</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {templates.map(t => {
            const Icon = CAP_ICON[t.capability] ?? Bot;
            return (
              <div key={t.id} className="rounded-lg border bg-card p-4 flex flex-col gap-2">
                <div className="flex items-center gap-2"><Icon className="h-4 w-4 text-primary" /><span className="font-medium">{t.name}</span>{t.specialization && <Badge variant="outline" className="text-[10px]">{t.specialization}</Badge>}</div>
                <p className="text-xs text-muted-foreground flex-1">{t.description}</p>
                <Button size="sm" className="gap-2 self-start" onClick={() => setDeploy(t)}><Zap className="h-4 w-4" /> Deploy</Button>
              </div>
            );
          })}
        </div>
      </section>

      {/* Active roles */}
      {roles.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Active roles</h2>
          {roles.map(r => (
            <div key={r.id} className="flex items-center justify-between rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2 min-w-0">
                <Badge className="bg-primary/15 text-primary border border-primary/30">{r.capability}</Badge>
                <span className="font-medium truncate">{r.name}</span>
                {r.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30"><Zap className="h-3 w-3" /> earns autonomy</Badge>}
                <span className="text-xs text-muted-foreground">· {r.deployments ?? 0} deployment(s)</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button variant="ghost" size="sm" title="Undeploy everywhere" onClick={() => act(() => api.undeployRole(r.id))}>undeploy</Button>
                <Button variant="ghost" size="sm" title="Delete role" onClick={() => act(() => api.deleteRole(r.id))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Fleet agents */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Gauge className="h-4 w-4" /> Agents</h2>
        {!fleet ? <div className="text-sm text-muted-foreground">Loading…</div>
          : fleet.agents.length === 0 ? <div className="text-sm text-muted-foreground">No agents enrolled yet. Deploy a role to populate the fleet.</div>
          : (
            <div className="rounded-lg border bg-card divide-y">
              {fleet.agents.map(a => (
                <div key={a.agentId} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{a.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{a.trustTier}</Badge>
                      {a.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30 text-[10px]"><Zap className="h-3 w-3" /> autonomy</Badge>}
                      {a.killed && <Badge variant="destructive" className="text-[10px]">killed</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {a.quality ? `merge ${a.quality.mergeRate.toFixed(0)}% · revert ${a.quality.revertRate.toFixed(0)}% · drift ${a.quality.driftScore.toFixed(0)}` : "no quality data yet"} · {fmtCents(a.monthCostCents)}/mo
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" className="shrink-0" title={a.killed ? "Release kill-switch" : "Engage kill-switch"}
                    onClick={() => act(() => a.killed ? api.releaseKillSwitch(a.agentId) : api.engageKillSwitch(a.agentId, "fleet view"))}>
                    <Skull className={`h-4 w-4 ${a.killed ? "text-destructive" : ""}`} />
                  </Button>
                </div>
              ))}
            </div>
          )}
      </section>

      <DeployDialog orgId={orgId} template={deploy} onClose={() => setDeploy(null)} onDeployed={load} onError={setError} />
    </div>
  );
}

function DeployDialog({ orgId, template, onClose, onDeployed, onError }: { orgId: string; template: AgentRoleRow | null; onClose: () => void; onDeployed: () => Promise<void>; onError: (s: string) => void }) {
  const [name, setName] = useState(""); const [llmApiKey, setLlmApiKey] = useState(""); const [topic, setTopic] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { setName(template?.name ?? ""); setLlmApiKey(""); setTopic(""); }, [template]);
  if (!template) return null;
  async function go() {
    setBusy(true);
    try {
      const { role } = await api.createRole({ template: template!.slug, org: orgId, name, llmApiKey: llmApiKey || undefined, earnedAutonomy: template!.earnedAutonomy });
      await api.deployRole(role.id, { org: orgId, topic: topic || undefined });
      onClose(); await onDeployed();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={!!template} onOpenChange={v => !v && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Deploy “{template.name}” across the org</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{template.description} Runs in your container with your key; ClawHub never does inference.</p>
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
          <div><Label>LLM API key</Label><Input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="sealed on submit · never shown again" /></div>
          <div><Label>Only repos with topic (optional)</Label><Input value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. prod — blank = all org repos" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy || !name}>{busy ? "Deploying…" : "Deploy to org"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
