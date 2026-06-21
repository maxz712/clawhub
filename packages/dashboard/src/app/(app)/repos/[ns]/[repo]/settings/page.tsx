"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type CiPipeline, type MergePolicy, type Repo, type SecretRow as SecretRowT, type Webhook } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MergePolicyEditor } from "@/components/merge-policy-editor";
import { PipelineEditor } from "@/components/pipeline-editor";
import { StandingAgentsPanel } from "@/components/standing-agents-panel";
import { SecretRow } from "@/components/secret-row";
import { CopyBlock } from "@/components/copy-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2, Users, ShieldCheck, FlaskConical, CheckCircle2, RotateCw, Lock, Globe } from "lucide-react";

/**
 * Wraps a settings section so one failed fetch degrades only that section —
 * the tab chrome stays, and the user gets a retry instead of a blank page.
 */
function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex items-center justify-between gap-4">
        <span>Couldn&apos;t load this section: {message}</span>
        <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={onRetry}>
          <RotateCw className="h-4 w-4" /> Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export default function RepoSettingsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [repoData, setRepo] = useState<Repo | null>(null);
  const [pipelines, setPipelines] = useState<CiPipeline[]>([]);
  const [secrets, setSecrets] = useState<SecretRowT[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  // Per-section errors — one failed fetch no longer blanks the whole page.
  const [repoErr, setRepoErr] = useState<string | null>(null);
  const [ciErr, setCiErr] = useState<string | null>(null);
  const [secretsErr, setSecretsErr] = useState<string | null>(null);
  const [webhooksErr, setWebhooksErr] = useState<string | null>(null);

  const loadRepo = useCallback(async () => {
    setRepoErr(null);
    try { const r = await api.getRepo(ns, repo); setRepo(r.repo); }
    catch (e) { setRepoErr((e as Error).message); }
  }, [ns, repo]);
  const loadPipelines = useCallback(async () => {
    setCiErr(null);
    try { const p = await api.listPipelines(ns, repo); setPipelines(p.pipelines); }
    catch (e) { setCiErr((e as Error).message); }
  }, [ns, repo]);
  const loadSecrets = useCallback(async () => {
    setSecretsErr(null);
    try { const s = await api.listSecrets(ns, repo); setSecrets(s.secrets); }
    catch (e) { setSecretsErr((e as Error).message); }
  }, [ns, repo]);
  const loadWebhooks = useCallback(async () => {
    setWebhooksErr(null);
    try { const w = await api.listWebhooks(ns, repo); setWebhooks(w.webhooks); }
    catch (e) { setWebhooksErr((e as Error).message); }
  }, [ns, repo]);

  // Settle each call independently so a single failure (e.g. CI) doesn't take
  // down General/Policy/Secrets/Webhooks with it.
  useEffect(() => { void Promise.allSettled([loadRepo(), loadPipelines(), loadSecrets(), loadWebhooks()]); }, [loadRepo, loadPipelines, loadSecrets, loadWebhooks]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings · <code className="font-mono">{ns}/{repo}</code></h1>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="policy">Merge policy</TabsTrigger>
          <TabsTrigger value="ci">CI</TabsTrigger>
          <TabsTrigger value="standing">Standing agents</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="pt-4 space-y-6">
          {repoErr
            ? <SectionError message={repoErr} onRetry={() => void loadRepo()} />
            : repoData
              ? <GeneralSettings ns={ns} repo={repo} repoData={repoData} onSaved={loadRepo} />
              : <div className="text-muted-foreground text-sm">Loading…</div>}
        </TabsContent>

        <TabsContent value="policy" className="pt-4 space-y-6">
          {repoErr
            ? <SectionError message={repoErr} onRetry={() => void loadRepo()} />
            : repoData
              ? <>
                  <PolicySummary policy={repoData.mergePolicy} />
                  <MergePolicyEditor
                    initial={repoData.mergePolicy}
                    onSave={async p => { await api.patchRepo(ns, repo, { mergePolicy: p }); await loadRepo(); }}
                    onApplySolo={async () => { await api.enableSoloMode(ns, repo); await loadRepo(); }}
                  />
                </>
              : <div className="text-muted-foreground text-sm">Loading…</div>}
        </TabsContent>

        <TabsContent value="ci" className="pt-4 space-y-4">
          {ciErr
            ? <SectionError message={ciErr} onRetry={() => void loadPipelines()} />
            : <PipelineEditor ns={ns} repo={repo} pipelines={pipelines} onChange={loadPipelines} />}
        </TabsContent>

        <TabsContent value="standing" className="pt-4 space-y-4">
          <StandingAgentsPanel ns={ns} repo={repo} />
        </TabsContent>

        <TabsContent value="secrets" className="pt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Sealed at rest and exposed only to CI runs as environment variables. Values cannot be read back — only replaced or deleted.
          </p>
          {secretsErr
            ? <SectionError message={secretsErr} onRetry={() => void loadSecrets()} />
            : <>
                <SecretAddForm ns={ns} repo={repo} onAdded={loadSecrets} />
                {secrets.length === 0
                  ? <div className="text-muted-foreground text-sm">No secrets set.</div>
                  : secrets.map(s => <SecretRow key={s.name} row={s} onDelete={async name => { await api.deleteSecret(ns, repo, name); await loadSecrets(); }} />)}
              </>}
        </TabsContent>

        <TabsContent value="webhooks" className="pt-4 space-y-3">
          {webhooksErr
            ? <SectionError message={webhooksErr} onRetry={() => void loadWebhooks()} />
            : <>
                <WebhookAddForm ns={ns} repo={repo} onAdded={loadWebhooks} />
                {webhooks.length === 0
                  ? <div className="text-muted-foreground text-sm">No webhooks.</div>
                  : webhooks.map(w => (
                    <div key={w.id} className="flex items-center justify-between p-3 rounded border bg-card">
                      <div className="min-w-0">
                        <code className="font-mono text-sm truncate block">{w.url}</code>
                        <div className="text-xs text-muted-foreground">{w.events.length ? w.events.join(", ") : "all events"}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={async () => { await api.deleteWebhook(ns, repo, w.id); await loadWebhooks(); }}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
              </>}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * General repo settings (GAP 1): description, visibility, and default branch —
 * the basics that previously had no home anywhere. All wired to PATCH /repos/:ns/:repo.
 */
function GeneralSettings({ ns, repo, repoData, onSaved }: { ns: string; repo: string; repoData: Repo; onSaved: () => Promise<void> }) {
  const [description, setDescription] = useState(repoData.description ?? "");
  const [isPublic, setIsPublic] = useState(repoData.isPublic);
  const [defaultBranch, setDefaultBranch] = useState(repoData.defaultBranch);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Default-branch options come from the branch list when available; we always
  // include the current value so a stale/empty branch list never drops it.
  useEffect(() => {
    api.getBranches(ns, repo)
      .then(r => setBranches(r.branches.map(b => b.name)))
      .catch(() => setBranches([])); // soft-fail: fall back to free-form current value
  }, [ns, repo]);

  const branchOptions = Array.from(new Set([repoData.defaultBranch, ...(branches ?? [])])).filter(Boolean);
  const dirty = description !== (repoData.description ?? "") || isPublic !== repoData.isPublic || defaultBranch !== repoData.defaultBranch;

  async function save() {
    setPending(true); setError(null); setSaved(false);
    try {
      await api.patchRepo(ns, repo, { description, isPublic, defaultBranch });
      await onSaved();
      setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4 max-w-2xl">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="space-y-2">
        <Label>Description</Label>
        <Textarea value={description} onChange={e => { setDescription(e.target.value); setSaved(false); }} placeholder="What does this repo do?" rows={2} />
        <p className="text-xs text-muted-foreground">Shown on the repo home, explore, and trending pages.</p>
      </div>

      <div className="space-y-2">
        <Label>Visibility</Label>
        <Select value={isPublic ? "public" : "private"} onValueChange={v => { setIsPublic(v === "public"); setSaved(false); }}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="private"><span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Private</span></SelectItem>
            <SelectItem value="public"><span className="flex items-center gap-2"><Globe className="h-4 w-4" /> Public</span></SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {isPublic ? "Anyone can browse the code, changes, and activity." : "Only collaborators and the owning namespace can see this repo."}
        </p>
      </div>

      <div className="space-y-2">
        <Label>Default branch</Label>
        <Select value={defaultBranch} onValueChange={v => { if (v) { setDefaultBranch(v); setSaved(false); } }}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {branchOptions.map(b => <SelectItem key={b} value={b}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">The branch Changes target and CI runs against by default.</p>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || !dirty}>{pending ? "Saving…" : "Save changes"}</Button>
        {saved && !dirty && <span className="flex items-center gap-1 text-xs text-primary"><CheckCircle2 className="h-3.5 w-3.5" /> Saved</span>}
      </div>

      <p className="text-xs text-muted-foreground border-t border-border pt-3">
        Branch protection rules (per-branch required reviews/CI) are planned but not yet editable here.
      </p>
    </div>
  );
}

/**
 * At-a-glance summary of the effective merge policy (GAP 5: discoverability) —
 * who must approve at what risk, whether CI gates, and whether a solo owner can
 * self-approve. Read-only; the editor below is where it's changed.
 */
function PolicySummary({ policy }: { policy: MergePolicy }) {
  const code = policy.codeReviewRequiredAtRisk ?? "high";
  const human =
    policy.requireHumanApproval === "always" ? "Every merge needs a human approval."
      : policy.requireHumanApproval === "never" ? "Agent approvals can merge at any risk (no human required)."
        : `A human must approve at ${policy.requireHumanApprovalLevel} risk or above.`;
  const rows: Array<{ icon: React.ReactNode; label: string; value: string }> = [
    { icon: <ShieldCheck className="h-4 w-4 text-primary" />, label: "Human approval", value: human },
    { icon: <ShieldCheck className="h-4 w-4 text-primary" />, label: "Code review", value: `Required at ${code} risk or above, and on sensitive paths (a behavior-only approval won't unblock those).` },
    { icon: <FlaskConical className="h-4 w-4 text-primary" />, label: "CI", value: policy.ciRequired ? "Must pass before merge." : "Not required to merge." },
    { icon: <Users className="h-4 w-4 text-primary" />, label: "Solo mode", value: policy.allowSelfReview ? "On — the authoring agent can self-approve low-risk work; your approval always counts." : "Off — a separate human reviewer is required." },
  ];
  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="text-sm font-medium">Current merge policy</div>
      <dl className="space-y-2">
        {rows.map(r => (
          <div key={r.label} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 shrink-0">{r.icon}</span>
            <dt className="w-28 shrink-0 text-muted-foreground">{r.label}</dt>
            <dd className="flex-1">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SecretAddForm({ ns, repo, onAdded }: { ns: string; repo: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try { await api.setSecret(ns, repo, name, value); setName(""); setValue(""); setOpen(false); await onAdded(); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <>
    <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add secret</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add secret</DialogTitle></DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="NPM_TOKEN" /></div>
          <div><Label>Value</Label><Input type="password" value={value} onChange={e => setValue(e.target.value)} /></div>
          <p className="text-xs text-muted-foreground">Sealed at rest; injected into CI runs as an env var. It can&apos;t be read back later — only replaced.</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={!name || !value}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function WebhookAddForm({ ns, repo, onAdded }: { ns: string; repo: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  async function save() {
    setError(null);
    try {
      const r = await api.createWebhook(ns, repo, { url, events: events ? events.split(",").map(s => s.trim()) : [] });
      setSecret(r.webhook.secret ?? null);
      await onAdded();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <>
    <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add webhook</Button>
    <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) { setUrl(""); setEvents(""); setSecret(null); } }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add webhook</DialogTitle></DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {secret ? (
          <div className="space-y-2">
            <Alert variant="destructive">
              <AlertDescription>
                Copy this signing secret now — it is shown <strong>once</strong> and cannot be retrieved again. Closing this dialog discards it.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Signing secret" value={secret} />
          </div>
        ) : (
          <div className="space-y-3">
            <div><Label>URL</Label><Input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/hooks/clawhub" /></div>
            <div><Label>Events (comma-separated, empty = all)</Label><Input value={events} onChange={e => setEvents(e.target.value)} placeholder="change.opened, ci.completed" /></div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>{secret ? "Close" : "Cancel"}</Button>
          {!secret && <Button onClick={save} disabled={!url}>Create</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
