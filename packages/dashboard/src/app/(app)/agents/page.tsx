"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Agent, type LlmKeyRow, type StandingAgentWithRepo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConnectAgentCard } from "@/components/connect-agent-card";
import { NewAgentDialog } from "@/components/new-agent-dialog";
import { Plus, Bot, Trash2, TriangleAlert, Pencil } from "lucide-react";

// v4 hub Overview (docs/redesign-v4.md): a ROSTER, not a control panel.
// Deployments are repo-less (identity + role + LLM only); their WORK lives on
// the Workflows tab; identity detail lives on /people/<name>. Role-minted
// workers fold straight into Standing — no sub-grouping.

// `model` rides on deployment rows from the v4 API; the base type predates it.
type DeploymentRow = StandingAgentWithRepo & { model?: string | null };

const KEEP_KEY = "__keep__";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [repoCount, setRepoCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [runBusy, setRunBusy] = useState<string | null>(null);
  const [standing, setStanding] = useState<DeploymentRow[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const [removing, setRemoving] = useState(false);

  // Edit-deployment dialog (global deployments only).
  const [editDep, setEditDep] = useState<DeploymentRow | null>(null);
  const [editModel, setEditModel] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editKeyId, setEditKeyId] = useState<string>(KEEP_KEY);
  const [keys, setKeys] = useState<LlmKeyRow[]>([]);
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    const [a, r, sa] = await Promise.all([
      api.listAgents(),
      api.listRepos().catch(() => ({ repos: [] })),
      api.listMyStandingAgents().catch(() => ({ standingAgents: [] })),
    ]);
    setAgents(a.agents);
    setRepoCount(r.repos.length);
    setStanding((sa.standingAgents as DeploymentRow[]) ?? []);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); }, []);

  async function runNow(sr: DeploymentRow) {
    setRunBusy(sr.id); setError(null);
    try {
      // Global (repo-less) deployments run via the hub endpoint; legacy
      // per-repo rows keep the repo-scoped one.
      if (sr.repoNs && sr.repoName) await api.runStandingAgent(sr.repoNs, sr.repoName, sr.id);
      else await api.runDeployment(sr.id);
    } catch (e) { setError((e as Error).message); }
    finally { setTimeout(() => setRunBusy(null), 1200); }
  }

  async function removeDeployment(sr: DeploymentRow) {
    const where = sr.repoNs ? `${sr.repoNs}/${sr.repoName}` : "all repos";
    if (!confirm(`Remove deployment “${sr.name}” (${where})? Its workflows stop dispatching.`)) return;
    setError(null);
    try {
      if (sr.repoNs && sr.repoName) await api.deleteStandingAgent(sr.repoNs, sr.repoName, sr.id);
      else await api.deleteDeployment(sr.id);
      await load();
    } catch (e) { setError((e as Error).message); }
  }

  function openEdit(sr: DeploymentRow) {
    setEditDep(sr);
    setEditModel(sr.model ?? "");
    setEditEnabled(sr.enabled);
    setEditKeyId(KEEP_KEY);
    api.listLlmKeys().then(r => setKeys(r.keys)).catch(() => setKeys([]));
  }

  async function saveEdit() {
    if (!editDep) return;
    setEditBusy(true); setError(null);
    try {
      await api.updateDeployment(editDep.id, {
        model: editModel.trim() || null,
        enabled: editEnabled,
        ...(editKeyId !== KEEP_KEY ? { llmKeyId: editKeyId } : {}),
      });
      setEditDep(null);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setEditBusy(false); }
  }

  async function removeAgent() {
    if (!confirmDelete) return;
    setRemoving(true); setError(null);
    try { await api.deleteAgent(confirmDelete.id); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setRemoving(false); }
  }

  // First-run onboarding: a logged-in user with no agents and no visible
  // repos sees the same "Connect your first agent" card as the repos page.
  const showOnboarding = agents !== null && agents.length === 0 && repoCount === 0;

  // One identity kind, two run modes. WRAPPERS have no standing deployment —
  // the human runs them locally by pasting the token into a tool. STANDING
  // agents have ≥1 deployment ClawHub runs; role-minted workers fold in here
  // as peers (v4 — no "Deployed by roles" sub-group).
  const deployedAgentIds = new Set(standing.map(sr => sr.agentId).filter((x): x is string => !!x));
  const wrappers = (agents ?? [])
    .filter(a => !deployedAgentIds.has(a.id) && !a.roleName)
    // The default personal agent sorts first.
    .sort((x, y) => Number(!!y.isPersonal) - Number(!!x.isPersonal));
  const standingIdentities = (agents ?? []).filter(a => deployedAgentIds.has(a.id) || a.roleName);

  function identityCard(a: Agent, kind: "wrapper" | "standing") {
    const mine = standing.filter(sr => sr.agentId === a.id);
    return (
      <li key={a.id} className="relative group">
        <Card className="h-full transition-colors group-hover:border-primary/40">
          <CardContent className="pt-5">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {/* The NAME is the door to the identity page — the roster stays lean. */}
                  <Link href={`/people/${a.name}`} className="font-mono font-semibold truncate hover:underline hover:text-primary">{a.name}</Link>
                  {a.isPersonal && <Badge variant="outline" className="text-[10px]">default</Badge>}
                  {a.roleName && <Badge variant="outline" className="text-[10px]">role</Badge>}
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {a.accessRoleName
                    ? <Badge variant="secondary" className="text-[10px]">{a.accessRoleName}</Badge>
                    : <>
                        {a.capabilities?.push && <Badge variant="secondary" className="text-[10px]">push</Badge>}
                        {a.capabilities?.review && <Badge variant="secondary" className="text-[10px]">review</Badge>}
                      </>}
                </div>
                {kind === "wrapper" && (
                  <p className="mt-2 text-xs text-muted-foreground">Paste its token into a local tool — pushes commit as this identity.</p>
                )}
              </div>
              {/* spacer so the title row clears the absolute Remove button */}
              <div className="w-7 shrink-0" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 border-t pt-3">
              <div>
                <div className="text-lg font-semibold leading-none">{a.stats.changesOpened}</div>
                <div className="mt-1 text-xs text-muted-foreground">changes opened</div>
              </div>
              <div>
                <div className="text-lg font-semibold leading-none">{a.stats.reviewsSubmitted}</div>
                <div className="mt-1 text-xs text-muted-foreground">reviews submitted</div>
              </div>
            </div>
          </CardContent>
        </Card>
        {/* Deployment rows: where/how it runs + Run now / Edit / Remove. */}
        {kind === "standing" && mine.length > 0 && (
          <div className="mt-1 space-y-1">
            {mine.map(sr => (
              <div key={sr.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-xs">
                <span className="font-mono truncate">{sr.repoNs ? `${sr.repoNs}/${sr.repoName}` : "all repos"}</span>
                <Badge variant="secondary" className="text-[10px]">{sr.llmProvider}</Badge>
                {sr.model && <Badge variant="outline" className="text-[10px] font-mono">{sr.model}</Badge>}
                {!sr.enabled && <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/30">paused</Badge>}
                <span className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    className="cursor-pointer text-primary hover:underline disabled:opacity-50"
                    disabled={runBusy === sr.id}
                    onClick={() => void runNow(sr)}
                  >
                    {runBusy === sr.id ? "Queued…" : "Run now"}
                  </button>
                  {!sr.repoNs && (
                    <button type="button" title="Edit deployment" className="cursor-pointer text-muted-foreground hover:text-foreground" onClick={() => openEdit(sr)}>
                      <Pencil className="h-3 w-3" />
                    </button>
                  )}
                  <button type="button" title="Remove deployment" className="cursor-pointer text-muted-foreground hover:text-destructive" onClick={() => void removeDeployment(sr)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          title={`Remove ${a.name}`}
          aria-label={`Remove ${a.name}`}
          onClick={() => setConfirmDelete(a)}
          className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </li>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground mt-1">The AI identities that push code and submit reviews on your behalf — every one is yours to govern.</p>
        </div>
        {!showOnboarding && (
          <Button size="sm" className="gap-2" onClick={() => setNewOpen(true)}><Plus className="h-4 w-4" /> New agent</Button>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!agents ? <div className="text-muted-foreground">Loading…</div>
        : showOnboarding ? (
          <ConnectAgentCard onConnected={() => void load()} />
        ) : agents.length === 0 ? (
          <Card><CardContent className="pt-6 text-center text-muted-foreground">No agents yet. Create one with the New agent button.</CardContent></Card>
        ) : (
          <>
          {wrappers.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Wrappers — run on your machine</h2>
              <p className="text-xs text-muted-foreground">Identities you drive from a local tool (Claude Code, Cursor, a script). ClawHub holds no runtime for them — just the identity and its permissions.</p>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {wrappers.map(a => identityCard(a, "wrapper"))}
              </ul>
            </div>
          )}
          {standingIdentities.length > 0 && (
            <div className="space-y-2 pt-2">
              <div className="flex items-baseline gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Standing — ClawHub runs them</h2>
                <Link href="/agents/workflows" className="text-xs text-primary hover:underline">give them work in Workflows →</Link>
              </div>
              <p className="text-xs text-muted-foreground">Deployed identities ClawHub runs — no machine of yours involved. What they DO lives on the Workflows tab.</p>
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {standingIdentities.map(a => identityCard(a, "standing"))}
              </ul>
            </div>
          )}
          </>
        )}

      <NewAgentDialog open={newOpen} onOpenChange={setNewOpen} onCreated={() => void load()} />

      {/* Edit a global deployment — model / key / enabled. Everything else
          (instructions, cadence, scope) belongs to its workflows. */}
      <Dialog open={!!editDep} onOpenChange={v => { if (!v && !editBusy) setEditDep(null); }}>
        <DialogContent>
          {editDep && (
            <>
              <DialogHeader><DialogTitle>Edit deployment “{editDep.name}”</DialogTitle></DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Model</Label>
                  <Input value={editModel} onChange={e => setEditModel(e.target.value)} placeholder="Auto (routed by task)" className="mt-1.5 font-mono" />
                  <p className="mt-1 text-xs text-muted-foreground">Leave empty for automatic routing.</p>
                </div>
                <div>
                  <Label>LLM key</Label>
                  <Select value={editKeyId} onValueChange={v => setEditKeyId(v ?? KEEP_KEY)}>
                    <SelectTrigger className="w-full mt-1.5">
                      <SelectValue>{(v: string) => v === KEEP_KEY ? "Keep current" : (keys.find(k => k.id === v)?.name ?? "Pick a key")}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={KEEP_KEY}>Keep current</SelectItem>
                      {keys.map(k => <SelectItem key={k.id} value={k.id}>{k.name} ({k.provider})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" className="accent-primary" checked={editEnabled} onChange={e => setEditEnabled(e.target.checked)} />
                  Enabled — its workflows may dispatch runs
                </label>
              </div>
              <DialogFooter>
                <Button variant="ghost" disabled={editBusy} onClick={() => setEditDep(null)}>Cancel</Button>
                <Button disabled={editBusy} onClick={saveEdit}>{editBusy ? "Saving…" : "Save"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Remove (archive) an agent — token revoked + hidden from the list; the
          change/review history it authored is preserved. */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !removing) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Remove agent “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  This <strong>revokes the agent&apos;s token</strong> and removes it from your list. Any standing
                  deployment it has stops working. The changes and reviews it already authored are kept.
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="ghost" disabled={removing} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={removing} onClick={removeAgent}>{removing ? "Removing…" : "Remove agent"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
