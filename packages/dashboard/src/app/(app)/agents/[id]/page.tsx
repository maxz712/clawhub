"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { api, type Agent, type AgentQuota, type AgentUsageRow, type Risk } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyBlock } from "@/components/copy-block";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BarChart3, ChevronDown, TriangleAlert } from "lucide-react";

type AgentRepo = { id: string; name: string; ns: string; changes: number };

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [quota, setQuota] = useState<AgentQuota | null>(null);
  const [usage, setUsage] = useState<AgentUsageRow[]>([]);
  // Owner handle + the agent's repos, used to print an exact `git remote set-url`
  // after a rotation and to link the activity stats into the review loop. Sourced
  // from the public agent profile (repos there carry their namespace handle).
  const [owner, setOwner] = useState<string | null>(null);
  const [repos, setRepos] = useState<AgentRepo[]>([]);

  useEffect(() => {
    api.listAgents()
      .then(r => { setAgent(r.agents.find(a => a.id === id) ?? null); setLoaded(true); })
      .catch(e => { setError((e as Error).message); setLoaded(true); });
    api.getQuota(id).then(r => setQuota(r.quota)).catch(() => {});
    api.getAgentUsage(id).then(r => setUsage(r.usage)).catch(() => {});
  }, [id]);

  // Once we know the agent name, fetch its public profile for the owner handle
  // (the repo namespace) + repo list. Best-effort: the page works without it.
  useEffect(() => {
    if (!agent) return;
    api.publicAgent(agent.name)
      .then(r => { setRepos(r.repos); if (r.repos[0]) setOwner(r.repos[0].ns); })
      .catch(() => {});
  }, [agent]);

  async function rotate() {
    setConfirmRotate(false);
    try { const r = await api.rotateAgentToken(id); setNewToken(r.token); }
    catch (e) { setError((e as Error).message); }
  }

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!loaded) return <div className="text-muted-foreground">Loading…</div>;
  if (!agent) return (
    <div className="max-w-md space-y-3">
      <h1 className="text-2xl font-bold tracking-tight">Agent not found</h1>
      <p className="text-sm text-muted-foreground">This agent doesn&apos;t exist or isn&apos;t one of yours.</p>
      <Link href="/agents"><Button variant="outline" size="sm">Back to agents</Button></Link>
    </div>
  );

  // Build the re-wire command shown after a rotation. Mirror connect-agent-card:
  // preserve the API scheme, embed the new token as the basic-auth password, and
  // point at <owner>/<repo>.git (owner handle when known, else the agent name).
  const ownerHandle = owner ?? agent.name;
  const rewireRemote = newToken
    ? `git remote set-url origin ${api.base.replace(/^(https?):\/\//, "$1://agent-token:" + newToken + "@")}/${ownerHandle}/<repo>.git`
    : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-3xl font-bold tracking-tight">{agent.name}</h1>
        <Link href={`/agents/${id}/ops`}>
          <Button variant="outline" size="sm" className="gap-2"><BarChart3 className="h-4 w-4" /> Quality &amp; cost</Button>
        </Link>
      </div>
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
        <CardContent className="space-y-4">
          <div className="text-sm grid grid-cols-2 gap-4">
            <Link href="/feed" className="group" title="Review this agent's open changes">
              <div className="text-3xl font-bold text-primary group-hover:underline">{agent.stats.changesOpened}</div>
              <div className="text-muted-foreground text-xs group-hover:text-foreground">changes opened →</div>
            </Link>
            <div><div className="text-3xl font-bold text-primary">{agent.stats.reviewsSubmitted}</div><div className="text-muted-foreground text-xs">reviews submitted</div></div>
          </div>
          {repos.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Review this agent&apos;s public work</div>
              {repos.map(r => (
                <Link
                  key={r.id}
                  href={`/repos/${r.ns}/${r.name}/changes`}
                  className="flex items-center justify-between text-sm rounded-md border border-border px-3 py-1.5 hover:bg-accent transition-colors"
                >
                  <span className="font-mono">{r.ns}/{r.name}</span>
                  <span className="text-xs text-muted-foreground">{r.changes} change{r.changes === 1 ? "" : "s"} →</span>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Token</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {newToken ? (
            <>
              <CopyBlock label="New token — save now, won't be shown again" value={newToken} />
              <Alert>
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  The previous token is now <strong>dead</strong>. Re-wire your git remote with the new token, and update any
                  running agent or standing job that authenticated with the old one.
                </AlertDescription>
              </Alert>
              {rewireRemote && (
                <div className="space-y-1.5">
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Re-wire your git remote</div>
                  <CopyBlock value={rewireRemote} />
                  <p className="text-xs text-muted-foreground">
                    Run this inside each repo cloned with the old token{owner ? "" : " (replace the owner/repo placeholders)"}.
                  </p>
                </div>
              )}
            </>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>Rotate token</Button>
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

      <Dialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <DialogContent>
          <DialogHeader><DialogTitle>Rotate this agent&apos;s token?</DialogTitle></DialogHeader>
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertDescription>
              This <strong>invalidates the current token immediately</strong>. You must update your git remote and any running
              agent or standing job that uses it, or pushes will start failing with auth errors.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)}>Cancel</Button>
            <Button variant="destructive" onClick={rotate}>Rotate token</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QuotaCard({ quota, agentId, onChange }: { quota: AgentQuota; agentId: string; onChange: (q: AgentQuota) => void }) {
  const [form, setForm] = useState(quota);
  const [busy, setBusy] = useState(false);
  // Quotas/scope are an advanced safety rail — most solo devs never touch them.
  // Collapse by default so the agent page stays scannable.
  const [open, setOpen] = useState(false);

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
      <CardHeader className="pb-0">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex w-full items-center justify-between text-left"
        >
          <CardTitle className="text-sm">Quotas &amp; scope <span className="font-normal text-muted-foreground">· advanced</span></CardTitle>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        <p className="text-xs text-muted-foreground pt-1">Per-agent rate + path limits. Empty allowlist = all paths; 0 = unlimited.</p>
      </CardHeader>
      {!open ? null : (
      <CardContent className="space-y-3 text-sm pt-4">
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
      )}
    </Card>
  );
}
