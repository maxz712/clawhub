"use client";

import { useEffect, useState } from "react";
import { api, type AgentRoleRow } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CustomTemplateDialog } from "@/components/custom-template-dialog";
import { Bot, Shield, Boxes, Sparkles, Zap, Plus, Trash2, CheckCircle2, Rocket, Infinity as InfinityIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// Agent TEMPLATES (the legacy `agent_roles` — capability/mode/trigger/task
// bundles you deploy as standing agents). v3 renames these "Templates";
// "Role" now means access control only (see /agents/roles). The api methods
// keep their legacy `role` names.

const CAP_ICON: Record<string, typeof Bot> = { worker: Bot, reviewer: Shield, triager: Boxes, specialist: Sparkles };

const AUTONOMY_NOTE =
  "Earned autonomy lets a template's agent self-merge ONLY its own LOW-risk work, and only after it has a track record + clears the quality bar. It never bypasses sensitive-path, medium+/high-risk, or human-required gates.";

export default function TemplatesPage() {
  const [mine, setMine] = useState<AgentRoleRow[] | null>(null);
  const [loopRepos, setLoopRepos] = useState<Array<{ slug: string }> | null>(null);
  const [loopRepo, setLoopRepo] = useState<string>("");
  const router = useRouter();
  const [templates, setTemplates] = useState<AgentRoleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [deploy, setDeploy] = useState<AgentRoleRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AgentRoleRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [usingSlug, setUsingSlug] = useState<string | null>(null);

  async function load() {
    try { const r = await api.listRoles(); setMine(r.roles); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { void load(); }, []);
  // Curated templates are the marketplace surface — load them so a brand-new
  // user (zero personal templates) has something ready to deploy instead of an
  // empty page that only offers "create from scratch".
  useEffect(() => {
    api.listRepos().then(r => setLoopRepos(r.repos.map(x => ({ slug: `${x.namespaceName}/${x.name}` })))).catch(() => setLoopRepos([]));
    api.listRoleTemplates().then(r => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, []);

  function flash(msg: string) { setNotice(msg); setError(null); }

  // Instantiate a curated template into a personal one the user can then deploy.
  async function applyTemplate(t: AgentRoleRow) {
    if (!t.slug) return;
    setUsingSlug(t.slug); setError(null); setNotice(null);
    try {
      const r = await api.createRole({ template: t.slug });
      flash(`Added “${t.name}” to your templates — click Deploy to put it on a repo.`);
      await load();
      // Jump straight into deploy: the natural next step after picking one.
      setDeploy(r.role);
    } catch (e) { setError((e as Error).message); }
    finally { setUsingSlug(null); }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setBusy(true); setError(null);
    try { await api.deleteRole(confirmDelete.id); flash(`Deleted template “${confirmDelete.name}”.`); setConfirmDelete(null); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-muted-foreground mt-1">Reusable agent templates — start from a curated one or build your own, then deploy to any repo you can write.</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => { setNotice(null); setCustomOpen(true); }}><Plus className="h-4 w-4" /> Create custom template</Button>
      </div>

      {/* The Loop is the highest-leverage deployment (scout → dev → verified-
          reviewer → merge) but lived only inside repo Settings — surface it
          where people shop for agents (docs/agents-ux.md). */}
      {(loopRepos?.length ?? 0) > 0 && (
        <Card className="border-primary/30">
          <CardContent className="pt-5 flex flex-wrap items-center gap-3">
            <InfinityIcon className="h-5 w-5 text-primary shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Want the whole loop, not one template?</div>
              <p className="text-xs text-muted-foreground">One click installs scout → developer → verified reviewer on a repo, with autonomy and cadence dials.</p>
            </div>
            <div className="flex items-center gap-2">
              <Select value={loopRepo} onValueChange={v => setLoopRepo(v ?? "")}>
                <SelectTrigger className="w-52"><SelectValue placeholder="Pick a repo" /></SelectTrigger>
                <SelectContent>
                  {loopRepos!.map(r => <SelectItem key={r.slug} value={r.slug}>{r.slug}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={!loopRepo} onClick={() => router.push(`/agents/standing?repo=${encodeURIComponent(loopRepo)}`)}>
                Set up Loop
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && (
        <Alert className="border-primary/30">
          <CheckCircle2 className="h-4 w-4 text-primary" />
          <AlertDescription className="text-foreground">{notice}</AlertDescription>
        </Alert>
      )}

      {/* Personal templates — only shown once the user has created some. */}
      {!mine ? <div className="text-muted-foreground">Loading…</div>
        : mine.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Your templates</h2>
            {mine.map(r => {
              const Icon = CAP_ICON[r.capability] ?? Bot;
              return (
                <div key={r.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border bg-card p-3">
                  <div className="flex items-center flex-wrap gap-2 min-w-0">
                    <Icon className="h-4 w-4 text-primary shrink-0" />
                    <Badge className="bg-primary/15 text-primary border border-primary/30">{r.capability}</Badge>
                    <span className="font-medium truncate">{r.name}</span>
                    {r.specialization && <Badge variant="outline" className="text-[10px]">{r.specialization}</Badge>}
                    {r.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30 text-[10px]" title={AUTONOMY_NOTE}><Zap className="h-3 w-3" /> autonomy</Badge>}
                    <span className="text-xs text-muted-foreground">· {r.deployments ?? 0} deployment(s)</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button variant="outline" size="sm" className="gap-2 h-9 w-9 sm:h-7 sm:w-7" disabled={busy} onClick={() => { setNotice(null); setDeploy(r); }}><Rocket className="h-4 w-4" /> Deploy</Button>
                    <Button variant="ghost" size="sm" className="h-9 w-9 sm:h-7 sm:w-7" title="Delete template" disabled={busy} onClick={() => { setNotice(null); setConfirmDelete(r); }}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      {/* Marketplace: curated templates anyone can deploy in one click. This is
          the new-user entry point — without it the page is an empty "create from
          scratch" dead end. */}
      {templates === null ? <div className="text-muted-foreground text-sm">Loading templates…</div>
        : templates.length === 0 ? (
          mine && mine.length === 0
            ? <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">No curated templates available. Use <strong>Create custom template</strong> above to build one.</div>
            : null
        ) : (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Start from a curated template</h2>
            <p className="text-sm text-muted-foreground mt-1">Curated agents you can deploy to a repo in one click — bring your own model key when prompted. Each runs in its own container; merge policy still gates every merge.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map(t => {
              const Icon = CAP_ICON[t.capability] ?? Bot;
              return (
                <Card key={t.id} className="flex flex-col">
                  <CardContent className="pt-6 flex flex-col gap-3 h-full">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-medium truncate">{t.name}</span>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap">
                      <Badge className="bg-primary/15 text-primary border border-primary/30 text-[10px]">{t.capability}</Badge>
                      {t.specialization && <Badge variant="outline" className="text-[10px]">{t.specialization}</Badge>}
                      <Badge variant="outline" className="text-[10px]">{t.trigger}</Badge>
                      {t.earnedAutonomy && <Badge variant="outline" className="gap-1 text-yellow-500 border-yellow-500/30 text-[10px]" title={AUTONOMY_NOTE}><Zap className="h-3 w-3" /> autonomy</Badge>}
                    </div>
                    {t.description && <p className="text-xs text-muted-foreground flex-1">{t.description}</p>}
                    <Button size="sm" variant="outline" className="gap-2 mt-auto" disabled={!!usingSlug} onClick={() => void applyTemplate(t)}>
                      <Rocket className="h-4 w-4" /> {usingSlug === t.slug ? "Adding…" : "Deploy"}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <CustomTemplateDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        onError={setError}
        onCreated={async name => { flash(`Created template “${name}”.`); await load(); }}
      />

      <DeployTemplateDialog template={deploy} onClose={() => setDeploy(null)} onDeployed={load} onError={setError} onNotice={flash} />

      {/* Confirm delete */}
      <Dialog open={!!confirmDelete} onOpenChange={v => { if (!v && !busy) setConfirmDelete(null); }}>
        <DialogContent>
          {confirmDelete && (
            <>
              <DialogHeader><DialogTitle>Delete template “{confirmDelete.name}”?</DialogTitle></DialogHeader>
              <p className="text-sm text-muted-foreground">Permanently removes this template. Existing deployments are removed first. This cannot be undone.</p>
              <DialogFooter>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy} onClick={doDelete}>{busy ? "Working…" : "Delete template"}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeployTemplateDialog({ template, onClose, onDeployed, onError, onNotice }: {
  template: AgentRoleRow | null;
  onClose: () => void;
  onDeployed: () => Promise<void>;
  onError: (s: string) => void;
  onNotice: (s: string) => void;
}) {
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  // Warn if no CI runner has ever connected — the agent would deploy fine but its
  // ticks would queue forever with no feedback. null = unknown (don't warn yet).
  const [runnerSeen, setRunnerSeen] = useState<boolean | null>(null);
  useEffect(() => {
    setRepo("");
    if (template) { setRunnerSeen(null); api.runnerStatus().then(r => setRunnerSeen(r.everSeen)).catch(() => setRunnerSeen(null)); }
  }, [template]);
  if (!template) return null;

  async function go() {
    const target = repo.trim();
    if (!target.includes("/")) { onError("Repo must be ns/name (e.g. acme/api)."); return; }
    setBusy(true);
    try {
      await api.deployRole(template!.id, { repo: target });
      onNotice(`Deployed “${template!.name}” to ${target}.`);
      onClose(); await onDeployed();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Dialog open={!!template} onOpenChange={v => { if (!v && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Deploy “{template.name}”</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">Deploys a standing agent for this template to a repo you can write. Runs in your container with your key.</p>
          {runnerSeen === false && (
            <Alert className="border-yellow-500/40">
              <AlertDescription className="text-xs text-yellow-200">
                ⚠ No CI runner has connected to this instance yet. The agent will deploy, but its runs will queue and won&apos;t execute until a runner is online. See <code>docs/standing-agents.md</code> to start one.
              </AlertDescription>
            </Alert>
          )}
          <div><Label>Repo (ns/name)</Label><Input value={repo} onChange={e => setRepo(e.target.value)} placeholder="e.g. acme/api" /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button onClick={go} disabled={busy || !repo.trim()}>{busy ? "Deploying…" : "Deploy to repo"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
