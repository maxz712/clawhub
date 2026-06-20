"use client";

import { useEffect, useState, use } from "react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Users, ShieldCheck, FlaskConical, CheckCircle2 } from "lucide-react";

export default function RepoSettingsPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [repoData, setRepo] = useState<Repo | null>(null);
  const [pipelines, setPipelines] = useState<CiPipeline[]>([]);
  const [secrets, setSecrets] = useState<SecretRowT[]>([]);
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    const [r, p, s, w] = await Promise.all([
      api.getRepo(ns, repo),
      api.listPipelines(ns, repo),
      api.listSecrets(ns, repo),
      api.listWebhooks(ns, repo),
    ]);
    setRepo(r.repo); setPipelines(p.pipelines); setSecrets(s.secrets); setWebhooks(w.webhooks);
  }
  useEffect(() => { loadAll().catch(e => setError((e as Error).message)); /* eslint-disable-next-line */ }, [ns, repo]);

  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!repoData) return <div className="text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings · <code className="font-mono">{ns}/{repo}</code></h1>
      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Merge policy</TabsTrigger>
          <TabsTrigger value="ci">CI</TabsTrigger>
          <TabsTrigger value="standing">Standing agents</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="policy" className="pt-4 space-y-6">
          <PolicySummary policy={repoData.mergePolicy} />
          <SoloModePanel ns={ns} repo={repo} policy={repoData.mergePolicy} onChanged={loadAll} />
          <MergePolicyEditor initial={repoData.mergePolicy} onSave={async p => { await api.patchRepo(ns, repo, { mergePolicy: p }); await loadAll(); }} />
        </TabsContent>

        <TabsContent value="ci" className="pt-4 space-y-4">
          <PipelineEditor ns={ns} repo={repo} pipelines={pipelines} onChange={loadAll} />
        </TabsContent>

        <TabsContent value="standing" className="pt-4 space-y-4">
          <StandingAgentsPanel ns={ns} repo={repo} />
        </TabsContent>

        <TabsContent value="secrets" className="pt-4 space-y-3">
          <SecretAddForm ns={ns} repo={repo} onAdded={loadAll} />
          {secrets.length === 0
            ? <div className="text-muted-foreground text-sm">No secrets set.</div>
            : secrets.map(s => <SecretRow key={s.name} row={s} onDelete={async name => { await api.deleteSecret(ns, repo, name); await loadAll(); }} />)}
        </TabsContent>

        <TabsContent value="webhooks" className="pt-4 space-y-3">
          <WebhookAddForm ns={ns} repo={repo} onAdded={loadAll} />
          {webhooks.length === 0
            ? <div className="text-muted-foreground text-sm">No webhooks.</div>
            : webhooks.map(w => (
              <div key={w.id} className="flex items-center justify-between p-3 rounded border bg-card">
                <div className="min-w-0">
                  <code className="font-mono text-sm truncate block">{w.url}</code>
                  <div className="text-xs text-muted-foreground">{w.events.length ? w.events.join(", ") : "all events"}</div>
                </div>
                <Button variant="ghost" size="sm" onClick={async () => { await api.deleteWebhook(ns, repo, w.id); await loadAll(); }}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
        </TabsContent>
      </Tabs>
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
    { icon: <Users className="h-4 w-4 text-primary" />, label: "Solo mode", value: policy.allowSelfReview ? "On — your own approval counts (low/medium)." : "Off — a separate human reviewer is required." },
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

/**
 * One-action "Solo mode" toggle for a team of one. POSTs the dedicated
 * /merge-policy/solo-mode endpoint so the canonical preset is applied
 * server-side (same one `ch repo solo-mode` uses) — self-approval at low/medium
 * while KEEPING the sensitive-path + high-risk code-review backstops. Shows the
 * current `allowSelfReview` state.
 */
function SoloModePanel({ ns, repo, policy, onChanged }: { ns: string; repo: string; policy: MergePolicy; onChanged: () => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = policy.allowSelfReview;

  async function enable() {
    setPending(true); setError(null);
    try { await api.enableSoloMode(ns, repo); await onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="h-4 w-4" /> Solo mode
            {on
              ? <Badge className="gap-1 bg-primary/15 text-primary border border-primary/30"><CheckCircle2 className="h-3 w-3" /> On</Badge>
              : <Badge variant="secondary">Off</Badge>}
          </div>
          <p className="text-xs text-muted-foreground">
            A team of one? Let your own approval count on low/medium changes — you approve your agent&apos;s work as the human.
            Sensitive paths (migrations, <code className="font-mono">*.sql</code>, <code className="font-mono">deploy/**</code>, Dockerfile, compose, policies) and high/critical risk still require a human who reviewed the code.
          </p>
        </div>
        <Button size="sm" className="gap-2 shrink-0" onClick={enable} disabled={pending || on}>
          <Users className="h-4 w-4" /> {pending ? "Enabling…" : on ? "Enabled" : "Enable Solo mode"}
        </Button>
      </div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
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
