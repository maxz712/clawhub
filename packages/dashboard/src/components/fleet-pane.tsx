"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type AgentRoleRow, type OrgFleet, type OrgDeployResult, type UndeployResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CustomRoleDialog } from "@/components/custom-role-dialog";
import { Bot, Shield, Gauge, Boxes, Sparkles, Zap, Skull, RotateCcw, Trash2, CheckCircle2, ChevronRight, Plus } from "lucide-react";

const CAP_ICON: Record<string, typeof Bot> = { worker: Bot, reviewer: Shield, triager: Boxes, specialist: Sparkles };
const fmtCents = (c: number) => `$${(c / 100).toFixed(2)}`;

const AUTONOMY_NOTE =
  "Earned autonomy lets a role self-merge ONLY its own LOW-risk work, and only after it has a track record + clears the quality bar. It never bypasses sensitive-path, medium+/high-risk, or human-required gates.";

/** A pending confirmation: the action to run + the human-readable label, plus an optional reason. */
type Confirm =
  | { kind: "undeploy"; role: AgentRoleRow }
  | { kind: "delete-role"; role: AgentRoleRow }
  | { kind: "kill"; agentId: string; name: string }
  | { kind: "release"; agentId: string; name: string };

// What the pane is scoped to: an org's fleet, or the caller's personal fleet.
// "Solo = N=1; same code as a team fleet" — both render the same roster +
// governance; org adds role deploy/fan-out (which needs an org id).
export type FleetScope = { kind: "org"; orgId: string } | { kind: "mine" };

// The fleet pane — every agent a scope runs, with roles, trust, quality, cost
// and kill in one place. Rendered at /orgs/:id/fleet (org), and inside the
// Agents hub's Fleet tab for either an org or the caller's personal fleet.
export function FleetPane({ scope }: { scope: FleetScope }) {
  const isOrg = scope.kind === "org";
  const orgId = scope.kind === "org" ? scope.orgId : null;

  const [fleet, setFleet] = useState<OrgFleet | null>(null);
  const [templates, setTemplates] = useState<AgentRoleRow[]>([]);
  const [roles, setRoles] = useState<AgentRoleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deploy, setDeploy] = useState<AgentRoleRow | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [killReason, setKillReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    // Fetch each piece independently so one failed call doesn't blank the whole
    // pane — the fleet snapshot is the load-bearing part; templates/roles are
    // best-effort and degrade to empty. Templates only matter for org deploy.
    const [f, t, r] = await Promise.allSettled([
      isOrg ? api.getOrgFleet(orgId!) : api.getMyFleet(),
      isOrg ? api.listRoleTemplates() : Promise.resolve({ templates: [] as AgentRoleRow[] }),
      isOrg ? api.listRoles(orgId!) : api.listRoles(),
    ]);
    if (f.status === "fulfilled") { setFleet(f.value); setError(null); }
    else setError((f.reason as Error).message);
    if (t.status === "fulfilled") setTemplates(t.value.templates);
    if (r.status === "fulfilled") setRoles(r.value.roles);
    setLoading(false);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope.kind, orgId]);

  function flash(msg: string) { setNotice(msg); setError(null); }

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      if (confirm.kind === "undeploy") {
        const res: UndeployResult = await api.undeployRole(confirm.role.id);
        flash(`Undeployed “${confirm.role.name}” — removed ${res.removed} deployment(s), revoked ${res.revoked} grant(s).`);
      } else if (confirm.kind === "delete-role") {
        await api.deleteRole(confirm.role.id);
        flash(`Deleted role “${confirm.role.name}”.`);
      } else if (confirm.kind === "kill") {
        await api.engageKillSwitch(confirm.agentId, killReason.trim() || "engaged from fleet view");
        flash(`Kill-switch engaged on “${confirm.name}”.`);
      } else {
        await api.releaseKillSwitch(confirm.agentId);
        flash(`Kill-switch released on “${confirm.name}”.`);
      }
      setConfirm(null); setKillReason("");
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2"><Bot className="h-6 w-6 text-primary" /> Fleet</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {isOrg
              ? "Every agent your org runs — roles, trust, quality, cost, kill — in one pane."
              : "Every agent you run — trust, quality, cost, kill — in one pane."}
          </p>
        </div>
        {fleet && <div className="text-right"><div className="text-xs text-muted-foreground" title="Agent self-reported BYO-LLM spend this month — ClawHub runs no inference">spend this month</div><div className="text-xl font-bold">{fmtCents(fleet.orgSpendCents)}</div></div>}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && (
        <Alert className="border-primary/30">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <AlertDescription className="text-foreground">{notice}</AlertDescription>
        </Alert>
      )}

      {/* Deploy a role from a template — org only (fan-out / org-owned roles). */}
      {isOrg && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Deploy a role</h2>
            <Button size="sm" variant="outline" className="gap-2" onClick={() => { setNotice(null); setCustomOpen(true); }}>
              <Plus className="h-4 w-4" /> Create custom role
            </Button>
          </div>
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
      )}

      {/* Roles. Org: full management (undeploy/delete). Personal: read-only, with
          a link to the Roles tab where you create + deploy them to a repo. */}
      {roles.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">{isOrg ? "Active roles" : "Your roles"}</h2>
            {!isOrg && <Link href="/agents/roles" className="text-xs text-primary hover:underline">Manage in Roles →</Link>}
          </div>
          {roles.map(r => (
            <div key={r.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1">
                <Badge className="bg-primary/15 text-primary border border-primary/30">{r.capability}</Badge>
                <span className="font-medium truncate">{r.name}</span>
                {r.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30" title={AUTONOMY_NOTE}><Zap className="h-3 w-3" /> earns autonomy</Badge>}
                <span className="text-xs text-muted-foreground">· {r.deployments ?? 0} deployment(s)</span>
              </div>
              {isOrg && (
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" title="Undeploy everywhere" disabled={busy} onClick={() => { setNotice(null); setConfirm({ kind: "undeploy", role: r }); }}>undeploy</Button>
                  <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7" title="Delete role" disabled={busy} onClick={() => { setNotice(null); setConfirm({ kind: "delete-role", role: r }); }}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      {/* Fleet agents */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground flex items-center gap-2"><Gauge className="h-4 w-4" /> Agents</h2>
        {loading && !fleet ? <div className="text-sm text-muted-foreground">Loading…</div>
          : !fleet ? <div className="text-sm text-muted-foreground">Fleet unavailable. {error ?? "Try again."}</div>
          : fleet.agents.length === 0 ? (
            isOrg
              ? <div className="text-sm text-muted-foreground">No agents enrolled yet. Deploy a role to populate the fleet.</div>
              : <div className="rounded-lg border bg-card p-6 text-center space-y-3">
                  <div className="text-sm text-muted-foreground">No agents yet.</div>
                  <div className="flex justify-center gap-2">
                    <Link href="/agents"><Button size="sm" variant="outline">Register an agent</Button></Link>
                    <Link href="/agents/roles"><Button size="sm" variant="outline">Deploy a role</Button></Link>
                  </div>
                </div>
          )
          : (
            <div className="rounded-lg border bg-card divide-y">
              {fleet.agents.map(a => (
                <div key={a.agentId} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3">
                  <Link href={`/agents/${a.agentId}`} className="min-w-0 group flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium truncate group-hover:text-primary">{a.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{a.trustTier}</Badge>
                      {a.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30 text-[10px]" title={AUTONOMY_NOTE}><Zap className="h-3 w-3" /> autonomy</Badge>}
                      {a.killed && <Badge variant="destructive" className="text-[10px]">killed</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {a.quality ? `merge ${a.quality.mergeRate.toFixed(0)}% · revert ${a.quality.revertRate.toFixed(0)}% · drift ${a.quality.driftScore.toFixed(0)}` : "no quality data yet"} · {fmtCents(a.monthCostCents)}/mo · view agent
                    </div>
                  </Link>
                  {a.killed
                    ? <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7 shrink-0 text-primary" title="Release kill switch (resume)" aria-label={`Release kill switch on ${a.name}`} disabled={busy} onClick={() => { setNotice(null); setConfirm({ kind: "release", agentId: a.agentId, name: a.name }); }}>
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    : <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7 shrink-0 hover:text-destructive" title="Engage kill switch (halt)" aria-label={`Engage kill switch on ${a.name}`} disabled={busy} onClick={() => { setNotice(null); setKillReason(""); setConfirm({ kind: "kill", agentId: a.agentId, name: a.name }); }}>
                        <Skull className="h-4 w-4" />
                      </Button>}
                  <Link href={`/agents/${a.agentId}`} className="shrink-0 text-muted-foreground hover:text-foreground" title="Open agent detail"><ChevronRight className="h-4 w-4" /></Link>
                </div>
              ))}
            </div>
          )}
      </section>

      {/* Earned-autonomy explainer */}
      <Alert className="border-yellow-500/30">
        <Zap className="h-4 w-4 text-yellow-500" />
        <AlertDescription className="text-muted-foreground">{AUTONOMY_NOTE}</AlertDescription>
      </Alert>

      {isOrg && orgId && (
        <>
          <DeployDialog orgId={orgId} template={deploy} onClose={() => setDeploy(null)} onDeployed={load} onError={setError} onNotice={flash} />
          <CustomRoleDialog
            open={customOpen}
            onOpenChange={setCustomOpen}
            orgId={orgId}
            onError={setError}
            onCreated={async name => { flash(`Created role “${name}”. Deploy it from Active roles.`); await load(); }}
          />
        </>
      )}

      {/* Confirm destructive actions */}
      <Dialog open={!!confirm} onOpenChange={v => { if (!v && !busy) { setConfirm(null); setKillReason(""); } }}>
        <DialogContent>
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {confirm.kind === "undeploy" ? `Undeploy “${confirm.role.name}” everywhere?`
                    : confirm.kind === "delete-role" ? `Delete role “${confirm.role.name}”?`
                    : confirm.kind === "release" ? `Release kill switch on “${confirm.name}”?`
                    : `Engage kill switch on “${confirm.name}”?`}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 text-sm text-muted-foreground">
                {confirm.kind === "undeploy" && <p>Removes every standing deployment of this role and revokes its repo grants. The role itself is kept — you can redeploy later.</p>}
                {confirm.kind === "delete-role" && <p>Permanently removes this role template. Existing deployments are removed first. This cannot be undone.</p>}
                {confirm.kind === "release" && <p>Resumes this agent — it can run and push again. Release only once you understand why it was halted.</p>}
                {confirm.kind === "kill" && (
                  <>
                    <p>Immediately halts this agent. Record why — it shows up in the audit trail.</p>
                    <div><Label>Reason</Label><Input autoFocus value={killReason} onChange={e => setKillReason(e.target.value)} placeholder="e.g. runaway spend / bad merges" /></div>
                  </>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => { setConfirm(null); setKillReason(""); }}>Cancel</Button>
                <Button variant={confirm.kind === "release" ? "default" : "destructive"} disabled={busy} onClick={runConfirm}>
                  {busy ? "Working…" : confirm.kind === "kill" ? "Engage kill switch" : confirm.kind === "release" ? "Release" : confirm.kind === "delete-role" ? "Delete role" : "Undeploy"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeployDialog({ orgId, template, onClose, onDeployed, onError, onNotice }: { orgId: string; template: AgentRoleRow | null; onClose: () => void; onDeployed: () => Promise<void>; onError: (s: string) => void; onNotice: (s: string) => void }) {
  const [name, setName] = useState(""); const [llmApiKey, setLlmApiKey] = useState(""); const [topic, setTopic] = useState("");
  const [target, setTarget] = useState<"org" | "repo">("org"); const [repo, setRepo] = useState("");
  const [earnedAutonomy, setEarnedAutonomy] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(template?.name ?? ""); setLlmApiKey(""); setTopic(""); setTarget("org"); setRepo("");
    setEarnedAutonomy(template?.earnedAutonomy ?? false);
  }, [template]);
  if (!template) return null;

  async function go() {
    setBusy(true);
    try {
      const { role } = await api.createRole({ template: template!.slug, org: orgId, name, llmApiKey: llmApiKey || undefined, earnedAutonomy });
      let res: OrgDeployResult;
      if (target === "repo") {
        if (!repo.includes("/")) { onError("Single-repo target must be ns/name (e.g. acme/api)."); setBusy(false); return; }
        res = await api.deployRole(role.id, { repo: repo.trim() });
        onNotice(`Deployed “${name}” to ${repo.trim()}.`);
      } else {
        res = await api.deployRole(role.id, { org: orgId, topic: topic.trim() || undefined });
        const parts = [`Deployed to ${res.deployed} repo(s)`];
        if (res.alreadyDeployed) parts.push(`${res.alreadyDeployed} already had it`);
        if (res.skipped?.length) parts.push(`${res.skipped.length} skipped`);
        onNotice(parts.join(", ") + (res.skipped?.length ? ` (${res.skipped.map(s => `${s.repo}: ${s.reason}`).join("; ")})` : "") + ".");
      }
      onClose(); await onDeployed();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!template} onOpenChange={v => { if (!v && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Deploy “{template.name}”</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{template.description} Runs in your container with your key; ClawHub never does inference.</p>
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} /></div>
          <div>
            <Label>Target</Label>
            <Select value={target} onValueChange={v => setTarget((v ?? "org") as "org" | "repo")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="org">Org-wide — fan out to every org repo</SelectItem>
                <SelectItem value="repo">Single repo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {target === "org"
            ? <div><Label>Only repos with topic (optional)</Label><Input value={topic} onChange={e => setTopic(e.target.value)} placeholder="e.g. prod — blank = all org repos" /></div>
            : <div><Label>Repo (ns/name)</Label><Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="e.g. acme/api" /></div>}
          <div><Label>LLM API key</Label><Input type="password" value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="sealed on submit · never shown again" /></div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={earnedAutonomy} onChange={e => setEarnedAutonomy(e.target.checked)} />
            <span><span className="font-medium text-foreground">Earned autonomy</span> — {AUTONOMY_NOTE}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy || !name || (target === "repo" && !repo)}>
            {busy ? "Deploying…" : target === "repo" ? "Deploy to repo" : "Deploy to org"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
