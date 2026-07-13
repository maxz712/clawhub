"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type Workflow, type WorkflowTemplate } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { WorkflowDialog, triggerSummary, type WorkflowPrefill } from "@/components/workflow-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, Pencil, Play, Plus, Search, Trash2, Workflow as WorkflowIcon } from "lucide-react";

// WORKFLOWS (v4, docs/redesign-v4.md): the one surface where agents get WORK.
// A workflow owns instructions + cadence + optional repo scope and hangs off a
// repo-less deployment; templates (the slash presets) fold in down the page.

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Dialog state — one shared dialog for create / edit / template-prefilled.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editWorkflow, setEditWorkflow] = useState<Workflow | null>(null);
  const [prefill, setPrefill] = useState<WorkflowPrefill | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<Workflow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);   // workflow id being acted on
  const [filter, setFilter] = useState("");

  async function load() {
    try { setWorkflows((await api.listWorkflows()).workflows); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    void load();
    api.listWorkflowTemplates().then(r => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  function openCreate() { setEditWorkflow(null); setPrefill(null); setNotice(null); setDialogOpen(true); }
  function openEdit(w: Workflow) { setEditWorkflow(w); setPrefill(null); setNotice(null); setDialogOpen(true); }
  function openFromTemplate(t: WorkflowTemplate) {
    setEditWorkflow(null);
    setPrefill({ name: t.label, instructions: t.instructions, trigger: t.suggestedTrigger, cron: t.suggestedCron, event: t.suggestedEvent });
    setNotice(null);
    setDialogOpen(true);
  }

  async function runNow(w: Workflow) {
    setBusy(w.id); setError(null); setNotice(null);
    try {
      const r = await api.runWorkflow(w.id);   // no repoId → the server fans out over the workflow's scope
      const ok = r.results.filter(x => x.ok).length;
      setNotice(r.dispatched > 0
        ? `Dispatched ${r.dispatched} run${r.dispatched === 1 ? "" : "s"} for “${w.name}”.`
        : `No runs dispatched for “${w.name}”${r.results[0]?.reason ? ` — ${r.results[0].reason}` : ok === 0 ? " — nothing in scope was eligible." : "."}`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function toggleEnabled(w: Workflow) {
    setBusy(w.id); setError(null);
    try { await api.updateWorkflow(w.id, { enabled: !w.enabled }); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setBusy(confirmDelete.id); setError(null);
    try { await api.deleteWorkflow(confirmDelete.id); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  // Client-side filter over the already-loaded roster — narrows the list as the
  // user types, no round trip (name, instructions, agent handle).
  const filteredWorkflows = useMemo(() => {
    if (!workflows) return workflows;
    const q = filter.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter(w =>
      w.name.toLowerCase().includes(q) ||
      (w.instructions ?? "").toLowerCase().includes(q) ||
      (w.agentName ?? "").toLowerCase().includes(q)
    );
  }, [workflows, filter]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Workflows</h1>
          <p className="text-muted-foreground mt-1">
            The work your deployed agents do — instructions + a cadence + an optional repo scope. Deployments are just identities; workflows are what they run.
          </p>
        </div>
        <Button size="sm" className="gap-2 shrink-0" onClick={openCreate}><Plus className="h-4 w-4" /> New workflow</Button>
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert className="border-primary/30"><AlertDescription className="text-foreground">{notice}</AlertDescription></Alert>}

      {/* The user's workflows */}
      {!workflows ? (
        <div className="space-y-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="rounded-lg border bg-card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-4 w-4 rounded-sm" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-16 rounded-full" />
                <Skeleton className="h-4 w-20 rounded-full" />
                <div className="ml-auto flex items-center gap-1.5">
                  <Skeleton className="h-7 w-16 rounded-md" />
                  <Skeleton className="h-7 w-7 rounded-md" />
                  <Skeleton className="h-7 w-7 rounded-md" />
                </div>
              </div>
              <Skeleton className="mt-2 ml-6 h-3 w-2/3" />
            </div>
          ))}
        </div>
      ) : workflows.length === 0 ? (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No workflows yet. Start from a template below, or use <strong>New workflow</strong>.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Filter workflows…"
                className="pl-8"
                aria-label="Filter workflows"
              />
            </div>
            {filteredWorkflows && filteredWorkflows.length === 0 ? (
              <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
                No workflows match &ldquo;{filter}&rdquo;.
              </div>
            ) : (
              <div className="space-y-2">
                {filteredWorkflows?.map(w => (
                  <div key={w.id} className="rounded-lg border bg-card p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <WorkflowIcon className="h-4 w-4 text-primary shrink-0" />
                      <Link href={`/agents/workflows/${w.id}`} className="font-medium hover:underline truncate">{w.name}</Link>
                      {w.agentName && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Bot className="h-3 w-3" /> <span className="font-mono">@{w.agentName}</span>
                        </span>
                      )}
                      <Badge variant="secondary" className="text-[10px]">{triggerSummary(w)}</Badge>
                      <Badge variant="outline" className="text-[10px]">{w.repoScope === "all" ? "all repos" : `${w.repoIds.length} repo${w.repoIds.length === 1 ? "" : "s"}`}</Badge>
                      {!w.enabled && <Badge variant="outline" className="text-[10px] text-yellow-500 border-yellow-500/30">paused</Badge>}
                      <div className="ml-auto flex items-center gap-1.5">
                        {/* Enabled toggle */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={w.enabled}
                          title={w.enabled ? "Pause this workflow" : "Resume this workflow"}
                          disabled={busy === w.id}
                          onClick={() => void toggleEnabled(w)}
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${w.enabled ? "bg-primary/80 border-primary" : "bg-muted border-border"}`}
                        >
                          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-background transition-transform ${w.enabled ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                        </button>
                        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" disabled={busy === w.id} onClick={() => void runNow(w)}>
                          <Play className="h-3 w-3" /> {busy === w.id ? "Working…" : "Run now"}
                        </Button>
                        <Button variant="outline" size="sm" className="h-7 w-7" title="Edit workflow" disabled={busy === w.id} onClick={() => openEdit(w)}><Pencil className="h-3.5 w-3.5" /></Button>
                        <Button variant="ghost" size="sm" className="h-7 w-7" title="Delete workflow" disabled={busy === w.id} onClick={() => setConfirmDelete(w)}><Trash2 className="h-3.5 w-3.5" /></Button>
                      </div>
                    </div>
                    {w.instructions && (
                      <p className="mt-1.5 pl-6 text-xs text-muted-foreground font-mono truncate" title={w.instructions}>{w.instructions}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      {/* Start from a template — the slash presets, prefilling the same dialog. */}
      {(templates?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Start from a template</h2>
          <p className="text-xs text-muted-foreground">Curated slash-flag workflows — Deploy opens the dialog prefilled; tweak anything before saving.</p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(templates ?? []).map(t => (
              <li key={t.key}>
                <Card className="h-full">
                  <CardContent className="pt-5 h-full flex flex-col">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.label}</span>
                      <Badge variant="secondary" className="text-[10px]">{t.mode}</Badge>
                      <code className="ml-auto font-mono text-xs text-primary">{t.instructions.split(/\s/)[0]}</code>
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground flex-1">{t.description}</p>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground">
                        suggested: {triggerSummary({ trigger: t.suggestedTrigger as Workflow["trigger"], cron: t.suggestedCron, event: t.suggestedEvent, intervalSec: 3600 })}
                      </span>
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => openFromTemplate(t)}>Deploy</Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        </div>
      )}

      <WorkflowDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workflow={editWorkflow}
        prefill={prefill}
        onSaved={() => { void load(); }}
      />

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Delete workflow “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Stops its schedule and removes it. Past runs stay in the Runs history. This cannot be undone.</p>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy === confirmDelete.id} onClick={doDelete}>{busy === confirmDelete.id ? "Deleting…" : "Delete workflow"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
