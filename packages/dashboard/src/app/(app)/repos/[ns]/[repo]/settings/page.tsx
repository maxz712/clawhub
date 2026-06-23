"use client";

import { useCallback, useEffect, useState, use } from "react";
import { api, type CiPipeline, type MergePolicy, type Repo, type SecretRow as SecretRowT, type Webhook } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MergePolicyEditor } from "@/components/merge-policy-editor";
import { PipelineEditor } from "@/components/pipeline-editor";
import { StandingAgentsPanel } from "@/components/standing-agents-panel";
import { SecretRow } from "@/components/secret-row";
import { WebhookDeliveriesPanel } from "@/components/webhook-deliveries";
import { BranchProtectionEditor } from "@/components/branch-protection-editor";
import { CopyBlock } from "@/components/copy-block";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2, Users, ShieldCheck, FlaskConical, CheckCircle2, RotateCw, Lock, Globe, Bot, Eye, KeyRound, FileCode2 } from "lucide-react";

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
  const [openDeliveries, setOpenDeliveries] = useState<Record<string, boolean>>({});
  const [collaborators, setCollaborators] = useState<CollaboratorRow[] | null>(null);
  // Per-section errors — one failed fetch no longer blanks the whole page.
  const [repoErr, setRepoErr] = useState<string | null>(null);
  const [ciErr, setCiErr] = useState<string | null>(null);
  const [secretsErr, setSecretsErr] = useState<string | null>(null);
  const [webhooksErr, setWebhooksErr] = useState<string | null>(null);
  const [collabErr, setCollabErr] = useState<string | null>(null);

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
  const loadCollaborators = useCallback(async () => {
    setCollabErr(null);
    try { const r = await api.listCollaborators(ns, repo); setCollaborators(r.collaborators); }
    catch (e) { setCollabErr((e as Error).message); }
  }, [ns, repo]);

  // Settle each call independently so a single failure (e.g. CI) doesn't take
  // down General/Policy/Secrets/Webhooks/Collaborators with it.
  useEffect(() => { void Promise.allSettled([loadRepo(), loadPipelines(), loadSecrets(), loadWebhooks(), loadCollaborators()]); }, [loadRepo, loadPipelines, loadSecrets, loadWebhooks, loadCollaborators]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="collaborators">Collaborators</TabsTrigger>
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

        <TabsContent value="collaborators" className="pt-4 space-y-4">
          {collabErr
            ? <SectionError message={collabErr} onRetry={() => void loadCollaborators()} />
            : <CollaboratorsSettings ns={ns} repo={repo} collaborators={collaborators} onChange={loadCollaborators} />}
        </TabsContent>

        <TabsContent value="policy" className="pt-4 space-y-6">
          {repoErr
            ? <SectionError message={repoErr} onRetry={() => void loadRepo()} />
            : repoData
              ? <>
                  <InRepoPolicyNote />
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
            Sealed at rest and exposed only to CI runs as environment variables. Values cannot be read back through the API — only replaced or deleted.
          </p>
          <Alert>
            <AlertDescription className="text-xs space-y-1.5">
              <p>
                <strong>Treat anyone who can edit this repo&apos;s pipelines as able to read these secrets.</strong> Secrets are
                decrypted and injected into CI runs in <strong>plaintext</strong> as environment variables, so a pipeline step
                (or a writer who edits one) can print or exfiltrate them. Scope each secret to the minimum it needs and rotate it
                at the source if a collaborator&apos;s access changes.
              </p>
              <p>
                Every <strong>push-triggered</strong> pipeline (<code className="font-mono">on: push</code>) gets the <strong>full</strong>
                decrypted secret set — including runs from an unmerged Change. So <strong>pipeline-edit access is effectively
                secret-read access</strong>; the required tier is repo <strong>writer</strong> (manage CI/secrets). For deploy-only
                credentials, prefer gating them behind a protected-branch <code className="font-mono">on: merge</code> pipeline, which
                only runs at the merge commit on the default branch.
              </p>
            </AlertDescription>
          </Alert>
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
                    <div key={w.id} className="p-3 rounded border bg-card">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <code className="font-mono text-sm truncate block">{w.url}</code>
                          <div className="text-xs text-muted-foreground">{w.events.length ? w.events.join(", ") : "all events"}</div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button variant="ghost" size="sm" onClick={() => setOpenDeliveries(d => ({ ...d, [w.id]: !d[w.id] }))}>
                            {openDeliveries[w.id] ? "Hide log" : "Deliveries"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={async () => { await api.deleteWebhook(ns, repo, w.id); await loadWebhooks(); }}><Trash2 className="h-4 w-4" /></Button>
                        </div>
                      </div>
                      {openDeliveries[w.id] && <WebhookDeliveriesPanel ns={ns} repo={repo} webhookId={w.id} />}
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

      <BranchProtectionEditor ns={ns} repo={repo} />
    </div>
  );
}

/**
 * Policy-as-code visibility (FLEET-MANAGER): an in-repo
 * `.clawhub/policies/merge.yml` is re-read on every push and OVERRIDES whatever
 * is configured here (`services/policy-dsl.ts`). The repo payload doesn't yet
 * expose whether that file is present at the default branch, so we surface a
 * standing note rather than silently letting a manager edit a policy that a
 * push will overwrite. (If the API later returns a `hasInRepoPolicy` flag, swap
 * this to a conditional "managed by …" banner.)
 */
function InRepoPolicyNote() {
  return (
    <Alert>
      <AlertDescription className="text-xs flex items-start gap-2">
        <FileCode2 className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
        <span>
          If this repo commits a <code className="font-mono">.clawhub/policies/merge.yml</code> file, it is the source of
          truth: ClawHub re-reads it on <strong>every push</strong> and it <strong>overrides the dashboard policy below</strong>.
          Edits made here will be overridden on the next push while that file exists — change the in-repo file (it is itself a
          sensitive path that needs a human to merge) to make policy changes stick.
        </span>
      </AlertDescription>
    </Alert>
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
  const [selected, setSelected] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  // Fetch the canonical event catalog so the user PICKS valid names rather than
  // typing free-text that silently never fires (server also validates).
  useEffect(() => {
    if (!open) return;
    api.webhookEventTypes(ns, repo).then(r => setCatalog(r.events)).catch(() => setCatalog([]));
  }, [open, ns, repo]);

  function toggle(ev: string) {
    setSelected(s => s.includes(ev) ? s.filter(e => e !== ev) : [...s, ev]);
  }
  function reset() { setUrl(""); setSelected([]); setSecret(null); setError(null); }
  async function save() {
    setError(null);
    try {
      const r = await api.createWebhook(ns, repo, { url, events: selected });
      setSecret(r.webhook.secret ?? null);
      await onAdded();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <>
    <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add webhook</Button>
    <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) reset(); }}>
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
            <div>
              <Label>Events <span className="text-muted-foreground font-normal">— none selected = all events</span></Label>
              <div className="mt-1 max-h-44 overflow-y-auto rounded border bg-background p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
                {catalog.length === 0
                  ? <div className="text-xs text-muted-foreground px-1 py-2">Loading events…</div>
                  : catalog.map(ev => (
                    <label key={ev} className="flex items-center gap-2 text-xs font-mono cursor-pointer rounded px-1 py-0.5 hover:bg-accent">
                      <input type="checkbox" checked={selected.includes(ev)} onChange={() => toggle(ev)} className="accent-primary" />
                      {ev}
                    </label>
                  ))}
              </div>
              {selected.length > 0 && <div className="text-[11px] text-muted-foreground mt-1">{selected.length} selected</div>}
            </div>
          </div>
        )}
        <DialogFooter>
          {/* Reset inline: Base UI's controlled Dialog does NOT fire onOpenChange
              when `open` is set programmatically, so without this the one-time
              signing secret would persist and re-show on the next open. */}
          <Button variant="ghost" onClick={() => { setOpen(false); reset(); }}>{secret ? "Close" : "Cancel"}</Button>
          {!secret && <Button onClick={save} disabled={!url}>Create</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

type CollaboratorRow = Awaited<ReturnType<typeof api.listCollaborators>>["collaborators"][number];

/**
 * Collaborators (GAP: repo-level access management). Lists the agents granted
 * push/review on this repo and lets an admin add / re-role / remove them.
 * Collaborators are always AGENTS in ClawHub — agents are *granted* access via
 * `repo_collaborators`; humans own the namespace and govern through it. The
 * `kind`/`name` fields are rendered when the API resolves them, with a graceful
 * fallback to the raw agent id.
 */
function CollaboratorsSettings({ ns, repo, collaborators, onChange }: {
  ns: string; repo: string; collaborators: CollaboratorRow[] | null; onChange: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // A stable per-row key (the table has no id column anymore — rows are an
  // agent grant OR a human grant).
  function keyOf(row: CollaboratorRow): string {
    return `${row.kind}:${row.agentId ?? row.userId ?? row.name ?? "?"}`;
  }
  function display(row: CollaboratorRow): { label: string; isAgent: boolean } {
    const isAgent = row.kind === "agent";
    const label = row.name?.trim() || row.agentName?.trim() || (isAgent ? `agent ${(row.agentId ?? "").slice(0, 8)}` : `user ${(row.userId ?? "").slice(0, 8)}`);
    return { label, isAgent };
  }

  async function changeRole(row: CollaboratorRow, role: "writer" | "reviewer") {
    if (role === row.role || !row.name) return;
    setError(null); setBusy(keyOf(row));
    try {
      if (row.kind === "human") await api.patchUserCollaboratorRole(ns, repo, row.name, role);
      else await api.patchCollaboratorRole(ns, repo, row.name, role);
      await onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }
  async function remove(row: CollaboratorRow) {
    if (!row.name) { setError("Cannot resolve this collaborator to remove it — refresh and retry."); return; }
    setError(null); setBusy(keyOf(row));
    try {
      if (row.kind === "human") await api.removeUserCollaborator(ns, repo, row.name);
      else await api.removeCollaborator(ns, repo, row.name);
      await onChange();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          Agents granted access to this repo. The only collaborator roles are <strong>writer</strong> (push commits, opening
          Changes under the merge policy) and <strong>reviewer</strong> (submit review verdicts only — cannot push). There is
          no &quot;admin&quot; collaborator role: repo-admin (settings, transfer, delete, collaborators) comes from owning the
          namespace or being an org admin — those people govern the repo and are not listed here.
        </p>
        <CollaboratorAddForm ns={ns} repo={repo} onAdded={onChange} />
      </div>

      {collaborators === null
        ? <div className="text-muted-foreground text-sm">Loading…</div>
        : collaborators.length === 0
          ? (
            <div className="rounded-lg border border-dashed bg-card/50 p-8 text-center">
              <Bot className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No collaborators yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add an agent by name to grant it push (writer) or review-only (reviewer) access.
              </p>
            </div>
          )
          : (
            <div className="space-y-2">
              {collaborators.map(row => {
                const { label, isAgent } = display(row);
                const k = keyOf(row);
                return (
                  <div key={k} className="flex items-center justify-between gap-3 rounded border bg-card p-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {isAgent
                        ? <Bot className="h-4 w-4 shrink-0 text-primary" aria-label="agent" />
                        : <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="human" />}
                      <code className="font-mono text-sm truncate">{label}</code>
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{isAgent ? "agent" : "human"}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Select
                        value={row.role}
                        onValueChange={v => void changeRole(row, v as "writer" | "reviewer")}
                        disabled={busy === k || !row.name}
                      >
                        <SelectTrigger className="w-32 h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="writer"><span className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5" /> writer</span></SelectItem>
                          <SelectItem value="reviewer"><span className="flex items-center gap-2"><Eye className="h-3.5 w-3.5" /> reviewer</span></SelectItem>
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" disabled={busy === k} onClick={() => void remove(row)} aria-label="Remove collaborator">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
    </div>
  );
}

function CollaboratorAddForm({ ns, repo, onAdded }: { ns: string; repo: string; onAdded: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"agent" | "human">("agent");
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState<"writer" | "reviewer">("writer");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  function reset() { setKind("agent"); setHandle(""); setRole("writer"); setError(null); }
  async function save() {
    setError(null); setPending(true);
    try {
      if (kind === "human") await api.addUserCollaborator(ns, repo, handle.trim(), role);
      else await api.addCollaborator(ns, repo, handle.trim(), role);
      reset(); setOpen(false); await onAdded();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }
  return (
    <>
    <Button size="sm" className="gap-2 shrink-0" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add collaborator</Button>
    <Dialog open={open} onOpenChange={v => { setOpen(v); if (!v) reset(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add collaborator</DialogTitle></DialogHeader>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <div className="space-y-3">
          <div>
            <Label>Collaborator type</Label>
            <Select value={kind} onValueChange={v => { setKind(v as "agent" | "human"); setHandle(""); }}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="agent"><span className="flex items-center gap-2"><Bot className="h-3.5 w-3.5" /> Agent</span></SelectItem>
                <SelectItem value="human"><span className="flex items-center gap-2"><Users className="h-3.5 w-3.5" /> Human</span></SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{kind === "agent" ? "Agent name" : "Username or email"}</Label>
            <Input value={handle} onChange={e => setHandle(e.target.value)} placeholder={kind === "agent" ? "my-agent" : "alice or alice@example.com"} />
            <p className="mt-1 text-xs text-muted-foreground">
              {kind === "agent"
                ? "The globally-unique agent name (agent names are unique across ClawHub)."
                : "Grants this person access to THIS repo only — without org-wide membership. Humans never push; a writer grant lets them merge/manage Changes here."}
            </p>
          </div>
          <div>
            <Label>Role</Label>
            <Select value={role} onValueChange={v => setRole(v as "writer" | "reviewer")}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="writer"><span className="flex items-center gap-2"><KeyRound className="h-3.5 w-3.5" /> writer</span></SelectItem>
                <SelectItem value="reviewer"><span className="flex items-center gap-2"><Eye className="h-3.5 w-3.5" /> reviewer</span></SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-muted-foreground">
              {kind === "agent"
                ? (role === "writer" ? "Writer: can push commits (opens Changes under the merge policy)." : "Reviewer: can only submit review verdicts — cannot push.")
                : (role === "writer" ? "Writer: push their own code (with their user token), plus review, merge, and manage." : "Reviewer: read + review verdicts only.")}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} disabled={!handle.trim() || pending}>{pending ? "Adding…" : "Add"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}
