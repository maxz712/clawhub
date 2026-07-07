"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Repo, type StandingAgentWithRepo, type Workflow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// The ONE create/edit workflow dialog (v4, docs/redesign-v4.md): a workflow is
// instructions + a trigger + an optional repo scope, attached to a repo-less
// DEPLOYMENT. Templates prefill it; editing reuses it. Kept deliberately in
// sync with the server's POST/PATCH /api/v1/workflows contract.

export type WorkflowPrefill = {
  name?: string;
  instructions?: string;
  trigger?: string;
  cron?: string | null;
  event?: string | null;
};

/** Human trigger summary — "daily 06:00 UTC" / "on change.opened" / "every 2h" / "manual". */
export function triggerSummary(w: Pick<Workflow, "trigger" | "cron" | "event" | "intervalSec">): string {
  if (w.trigger === "schedule") {
    const m = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec((w.cron ?? "").trim());
    if (m) return `daily ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")} UTC`;
    return w.cron ? `cron ${w.cron}` : "scheduled";
  }
  if (w.trigger === "event") return `on ${w.event ?? "event"}`;
  if (w.trigger === "continuous") {
    const sec = w.intervalSec || 3600;
    return sec >= 3600 ? `every ${Math.round(sec / 3600)}h` : `every ${Math.max(1, Math.round(sec / 60))}m`;
  }
  return "manual";
}

type TriggerKind = "manual" | "schedule" | "event" | "continuous";
const TRIGGER_LABELS: Record<TriggerKind, string> = {
  manual: "Manual — run it yourself",
  schedule: "Schedule (cron, UTC)",
  event: "On an event",
  continuous: "Continuously (interval)",
};
const DEFAULT_CRON = "0 6 * * *";
const DEFAULT_EVENT = "change.opened";

function asTrigger(t: string | undefined | null): TriggerKind {
  return t === "schedule" || t === "event" || t === "continuous" ? t : "manual";
}

export function WorkflowDialog({ open, onOpenChange, workflow, prefill, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Edit mode when set — the deployment is fixed, fields load from the row. */
  workflow?: Workflow | null;
  /** Template prefill for create mode. */
  prefill?: WorkflowPrefill | null;
  onSaved: () => void;
}) {
  const [deployments, setDeployments] = useState<StandingAgentWithRepo[] | null>(null);
  const [repos, setRepos] = useState<Repo[] | null>(null);

  const [name, setName] = useState("");
  const [standingAgentId, setStandingAgentId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [trigger, setTrigger] = useState<TriggerKind>("manual");
  const [cron, setCron] = useState(DEFAULT_CRON);
  const [event, setEvent] = useState(DEFAULT_EVENT);
  const [intervalHours, setIntervalHours] = useState("1");
  const [repoScope, setRepoScope] = useState<"all" | "selected">("all");
  const [repoIds, setRepoIds] = useState<string[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)seed the form each time the dialog opens — from the workflow being
  // edited, the template prefill, or blank defaults.
  useEffect(() => {
    if (!open) return;
    setError(null);
    api.listMyStandingAgents().then(r => {
      setDeployments(r.standingAgents);
      // Preselect the first deployment on create so the happy path is short.
      if (!workflow && r.standingAgents.length > 0) setStandingAgentId(prev => prev || r.standingAgents[0].id);
    }).catch(() => setDeployments([]));
    api.listRepos({ limit: 200 }).then(r => setRepos(r.repos)).catch(() => setRepos([]));
    if (workflow) {
      setName(workflow.name);
      setStandingAgentId(workflow.standingAgentId);
      setInstructions(workflow.instructions);
      setTrigger(asTrigger(workflow.trigger));
      setCron(workflow.cron ?? DEFAULT_CRON);
      setEvent(workflow.event ?? DEFAULT_EVENT);
      setIntervalHours(String(Math.max(1, Math.round((workflow.intervalSec || 3600) / 3600))));
      setRepoScope(workflow.repoScope);
      setRepoIds(workflow.repoIds ?? []);
      setShowAdvanced(workflow.repoScope === "selected");
    } else {
      setName(prefill?.name ?? "");
      setInstructions(prefill?.instructions ?? "");
      setTrigger(asTrigger(prefill?.trigger));
      setCron(prefill?.cron ?? DEFAULT_CRON);
      setEvent(prefill?.event ?? DEFAULT_EVENT);
      setIntervalHours("1");
      setRepoScope("all");
      setRepoIds([]);
      setShowAdvanced(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workflow, prefill]);

  function deploymentLabel(d: StandingAgentWithRepo): string {
    const where = d.repoNs ? `${d.repoNs}/${d.repoName}` : "all repos";
    return `${d.name} — ${where}`;
  }

  async function submit() {
    setBusy(true); setError(null);
    try {
      const body = {
        name: name.trim() || "Untitled workflow",
        instructions,
        trigger,
        cron: trigger === "schedule" ? cron.trim() : null,
        event: trigger === "event" ? event.trim() : null,
        intervalSec: trigger === "continuous" ? Math.max(1, Number(intervalHours) || 1) * 3600 : undefined,
        repoScope,
        repoIds: repoScope === "selected" ? repoIds : [],
      };
      if (workflow) await api.updateWorkflow(workflow.id, body);
      else await api.createWorkflow({ standingAgentId, ...body, enabled: true });
      onSaved();
      onOpenChange(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const noDeployments = !workflow && deployments !== null && deployments.length === 0;
  const canSubmit = Boolean(
    instructions.trim() &&
    (workflow || standingAgentId) &&
    (trigger !== "schedule" || cron.trim()) &&
    (trigger !== "event" || event.trim()) &&
    (repoScope !== "selected" || repoIds.length > 0),
  );

  return (
    <Dialog open={open} onOpenChange={v => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{workflow ? `Edit workflow “${workflow.name}”` : "New workflow"}</DialogTitle></DialogHeader>

        <div className="space-y-4">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

          {noDeployments ? (
            <Alert>
              <AlertDescription>
                No deployments yet — a workflow needs an agent to run it. Create one first with{" "}
                <Link href="/agents" className="text-primary hover:underline">New agent on the Overview tab</Link>{" "}
                (pick “ClawHub runs it”), then come back here to give it work.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="Nightly review sweep" className="mt-1.5" />
              </div>

              <div>
                <Label>Deployment — who runs it</Label>
                {workflow ? (
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    {workflow.deploymentName ?? workflow.agentName ?? "This workflow's deployment"} (fixed — create a new workflow to move work to another agent)
                  </p>
                ) : (
                  <Select value={standingAgentId} onValueChange={v => setStandingAgentId(v ?? "")}>
                    <SelectTrigger className="w-full mt-1.5">
                      <SelectValue>{(v: string) => {
                        const d = deployments?.find(x => x.id === v);
                        return d ? deploymentLabel(d) : "Pick a deployment";
                      }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {(deployments ?? []).map(d => <SelectItem key={d.id} value={d.id}>{deploymentLabel(d)}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <div>
                <Label>Instructions</Label>
                <Textarea className="mt-1.5 font-mono text-xs" rows={5} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="/review be strict about missing tests — or plain natural language" />
                <p className="mt-1 text-xs text-muted-foreground">
                  Slash flags expand server-side — lead with <code className="font-mono">/dev</code>, <code className="font-mono">/review</code>, <code className="font-mono">/verify</code>, <code className="font-mono">/scout</code>, <code className="font-mono">/triage</code> or <code className="font-mono">/loop</code>, optionally followed by extra focus. Plain natural language works too.
                </p>
              </div>

              <div>
                <Label>Trigger</Label>
                <Select value={trigger} onValueChange={v => setTrigger(asTrigger(v))}>
                  <SelectTrigger className="w-full mt-1.5">
                    <SelectValue>{(v: string) => TRIGGER_LABELS[asTrigger(v)]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TRIGGER_LABELS) as TriggerKind[]).map(t => <SelectItem key={t} value={t}>{TRIGGER_LABELS[t]}</SelectItem>)}
                  </SelectContent>
                </Select>
                {trigger === "schedule" && (
                  <div className="mt-2">
                    <Input value={cron} onChange={e => setCron(e.target.value)} placeholder={DEFAULT_CRON} className="font-mono" />
                    <p className="mt-1 text-xs text-muted-foreground">5-field UTC cron — <code className="font-mono">0 6 * * *</code> = daily 06:00 UTC.</p>
                  </div>
                )}
                {trigger === "event" && (
                  <div className="mt-2">
                    <Input value={event} onChange={e => setEvent(e.target.value)} placeholder={DEFAULT_EVENT} className="font-mono" />
                    <p className="mt-1 text-xs text-muted-foreground">A ClawHub event type — e.g. <code className="font-mono">change.opened</code>, <code className="font-mono">change.merged</code>.</p>
                  </div>
                )}
                {trigger === "continuous" && (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">every</span>
                    <Input type="number" min={1} value={intervalHours} onChange={e => setIntervalHours(e.target.value)} className="w-20" />
                    <span className="text-sm text-muted-foreground">hour(s)</span>
                  </div>
                )}
              </div>

              <div>
                <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced}>
                  {showAdvanced ? "▾" : "▸"} Advanced — repo scope
                </button>
                {showAdvanced && (
                  <div className="mt-2 space-y-2 rounded-md border border-border/60 p-3">
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="wf-scope" className="accent-primary" checked={repoScope === "all"} onChange={() => setRepoScope("all")} /> All repos the agent can reach
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="radio" name="wf-scope" className="accent-primary" checked={repoScope === "selected"} onChange={() => setRepoScope("selected")} /> Selected repos
                      </label>
                    </div>
                    {repoScope === "selected" && (
                      <div className="max-h-36 overflow-y-auto space-y-1">
                        {(repos ?? []).length === 0 && <p className="text-xs text-muted-foreground">No repos visible.</p>}
                        {(repos ?? []).map(r => (
                          <label key={r.id} className="flex items-center gap-2 text-sm cursor-pointer">
                            <input type="checkbox" className="accent-primary" checked={repoIds.includes(r.id)}
                              onChange={e => setRepoIds(ids => e.target.checked ? [...ids, r.id] : ids.filter(x => x !== r.id))} />
                            <span className="font-mono text-xs">{r.namespaceName}/{r.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            {!noDeployments && (
              <Button onClick={submit} disabled={busy || !canSubmit}>{busy ? "Saving…" : workflow ? "Save workflow" : "Create workflow"}</Button>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
