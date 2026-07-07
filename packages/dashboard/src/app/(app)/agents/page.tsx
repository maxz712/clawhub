"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type Agent, type LlmKeyRow, type StandingAgentWithRepo, type AccessRoleRow, type LlmCatalogModel } from "@/lib/api";
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
import { Textarea } from "@/components/ui/textarea";

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
  const [editName, setEditName] = useState("");
  const [editCpus, setEditCpus] = useState(2);
  const [editMemory, setEditMemory] = useState(4096);
  const [editTimeout, setEditTimeout] = useState(3600);
  const [editEgress, setEditEgress] = useState("none");
  const [editMode, setEditMode] = useState("develop");
  const [editTask, setEditTask] = useState("");

  const [roles, setRoles] = useState<AccessRoleRow[]>([]);
  const [editRoleId, setEditRoleId] = useState("");
  const [editLlmChoice, setEditLlmChoice] = useState<"platform" | "byo">("platform");
  const [catalog, setCatalog] = useState<LlmCatalogModel[]>([]);

  const modelOptions = useMemo(() => (catalog ?? []).filter(m => m.agentic !== false), [catalog]);

  async function load() {
    const [a, r, sa, ro, cat] = await Promise.all([
      api.listAgents(),
      api.listRepos().catch(() => ({ repos: [] })),
      api.listMyStandingAgents().catch(() => ({ standingAgents: [] })),
      api.listAccessRoles().catch(() => ({ roles: [] })),
      api.getLlmCatalog().catch(() => ({ models: [] })),
    ]);
    setAgents(a.agents);
    setRepoCount(r.repos.length);
    setStanding((sa.standingAgents as DeploymentRow[]) ?? []);
    setRoles(ro.roles);
    setCatalog(cat.models);
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
    const agent = agents?.find(a => a.id === sr.agentId);
    const role = roles.find(r => r.name === agent?.accessRoleName);
    setEditRoleId(role?.id ?? "");
    setEditName(sr.name ?? "");
    setEditModel(sr.model ?? "");
    setEditEnabled(sr.enabled);
    setEditKeyId(sr.llmKeyId ?? KEEP_KEY);
    setEditCpus(sr.cpus ?? 2);
    setEditMemory(sr.memoryMb ?? 4096);
    setEditTimeout(sr.timeoutSec ?? 3600);
    setEditEgress(sr.egressPolicy ?? "none");
    setEditMode(sr.mode ?? "develop");
    setEditTask(sr.task ?? "");
    setEditLlmChoice(sr.keySource === "platform" ? "platform" : "byo");
    api.listLlmKeys().then(r => setKeys(r.keys)).catch(() => setKeys([]));
  }

  async function saveEdit() {
    if (!editDep) return;
    setEditBusy(true); setError(null);
    try {
      await api.updateDeployment(editDep.id, {
        accessRoleId: editRoleId || undefined,
        keySource: editLlmChoice,
        model: editLlmChoice === "platform" ? (editModel || null) : null,
        llmKeyId: editLlmChoice === "byo" && editKeyId !== KEEP_KEY ? editKeyId : undefined,
        task: editTask,
        enabled: editEnabled,
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
    const dep = mine[0];
    return (
      <li key={a.id} className="relative group">
        <Card className="h-full transition-colors group-hover:border-primary/40">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 flex-1 pr-16">
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* The NAME is the door to the identity page — the roster stays lean. */}
                  <Link href={`/people/${a.name}`} className="font-mono font-semibold text-sm truncate hover:underline hover:text-primary">{a.name}</Link>
                  {a.isPersonal && <Badge variant="outline" className="text-[9px] px-1.5 py-0">default</Badge>}
                  {a.roleName && <Badge variant="outline" className="text-[9px] px-1.5 py-0">role</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {a.accessRoleName
                    ? <Badge variant="secondary" className="text-[9px] px-1.5 py-0">{a.accessRoleName}</Badge>
                    : <>
                        {a.capabilities?.push && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">push</Badge>}
                        {a.capabilities?.review && <Badge variant="secondary" className="text-[9px] px-1.5 py-0">review</Badge>}
                      </>}
                  {kind === "standing" && dep && (
                    <>
                      <Badge variant="secondary" className="text-[9px] px-1.5 py-0 bg-primary/10 text-primary border-primary/10">{dep.llmProvider}</Badge>
                      {dep.model && <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">{dep.model}</Badge>}
                      {!dep.enabled && <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-yellow-600 border-yellow-500/20 bg-yellow-500/5">paused</Badge>}
                    </>
                  )}
                </div>
                {kind === "wrapper" && (
                  <p className="mt-1.5 text-xs text-muted-foreground">Paste its token into a local tool — pushes commit as this identity.</p>
                )}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-4 border-t pt-2.5 text-xs text-muted-foreground">
              <div>
                <strong className="font-semibold text-foreground mr-1">{a.stats.changesOpened}</strong>
                changes opened
              </div>
              <div>
                <strong className="font-semibold text-foreground mr-1">{a.stats.reviewsSubmitted}</strong>
                reviews submitted
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action button group at top right */}
        <div className="absolute top-3 right-3 flex items-center gap-1 opacity-40 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {kind === "standing" && dep && (
            <>
              <button
                type="button"
                title="Run deployment now"
                disabled={runBusy === dep.id}
                onClick={() => void runNow(dep)}
                className="inline-flex h-7 px-2 items-center justify-center rounded-md text-xs font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {runBusy === dep.id ? "Queued…" : "Run now"}
              </button>
              <button
                type="button"
                title="Edit deployment"
                onClick={() => openEdit(dep)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            title={`Remove ${a.name}`}
            aria-label={`Remove ${a.name}`}
            onClick={() => setConfirmDelete(a)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
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

      <Dialog open={!!editDep} onOpenChange={v => { if (!v && !editBusy) setEditDep(null); }}>
        <DialogContent className="sm:max-w-[480px]">
          {editDep && (
            <>
              <DialogHeader><DialogTitle>Edit deployment “{editDep.name}”</DialogTitle></DialogHeader>
              <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
                <div>
                  <Label>Access Role</Label>
                  <Select value={editRoleId} onValueChange={v => setEditRoleId(v ?? "")}>
                    <SelectTrigger className="w-full mt-1.5">
                      <SelectValue>{(v: string) => roles.find(r => r.id === v)?.name ?? "Pick a role"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map(r => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">Defines what the agent is authorized to do (e.g. read, push, review, merge).</p>
                </div>

                <div>
                  <Label>General instructions (agent level)</Label>
                  <Textarea
                    value={editTask}
                    onChange={e => setEditTask(e.target.value)}
                    placeholder="System prompt / default role instructions for this agent (e.g. 'You are an autonomous UI engineer. Prefer clean code...')"
                    className="mt-1.5 h-20 text-xs"
                  />
                </div>

                <div>
                  <Label>LLM</Label>
                  <div className="mt-1.5 flex gap-4 text-sm">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="editLlm" className="accent-primary" checked={editLlmChoice === "platform"} onChange={() => setEditLlmChoice("platform")} />
                      Platform (metered)
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="editLlm" className="accent-primary" checked={editLlmChoice === "byo"} onChange={() => setEditLlmChoice("byo")} />
                      Bring your own key
                    </label>
                  </div>

                  {editLlmChoice === "platform" && (catalog?.length ?? 0) > 0 && (
                    <div className="mt-3">
                      <Label>Model</Label>
                      <Select value={editModel || "__auto__"} onValueChange={v => setEditModel(v === "__auto__" ? "" : (v ?? ""))}>
                        <SelectTrigger className="w-full mt-1.5">
                          <SelectValue>{(v: string) => v === "__auto__" ? "Auto (routed by task)" : v}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto__">Auto (routed by task)</SelectItem>
                          {modelOptions.map(m => <SelectItem key={m.id} value={m.id}>{m.id}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {editLlmChoice === "byo" && (
                    <div className="mt-3">
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
                  )}
                </div>

                <label className="flex items-center gap-2 text-sm cursor-pointer pt-2">
                  <input type="checkbox" className="accent-primary" checked={editEnabled} onChange={e => setEditEnabled(e.target.checked)} />
                  Enabled — its workflows may dispatch runs
                </label>
              </div>
              <DialogFooter className="pt-2">
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
