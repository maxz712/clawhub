"use client";

import { useEffect, useState, use } from "react";
import { api, type CiPipeline, type Repo, type SecretRow as SecretRowT, type Webhook } from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MergePolicyEditor } from "@/components/merge-policy-editor";
import { SecretRow } from "@/components/secret-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus, Trash2 } from "lucide-react";

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
      <h1 className="text-2xl font-bold tracking-tight font-mono">Settings · <code className="font-mono">{ns}/{repo}</code></h1>
      <Tabs defaultValue="policy">
        <TabsList>
          <TabsTrigger value="policy">Merge policy</TabsTrigger>
          <TabsTrigger value="ci">CI</TabsTrigger>
          <TabsTrigger value="secrets">Secrets</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
        </TabsList>

        <TabsContent value="policy" className="pt-4">
          <MergePolicyEditor initial={repoData.mergePolicy} onSave={async p => { await api.patchRepo(ns, repo, { mergePolicy: p }); await loadAll(); }} />
        </TabsContent>

        <TabsContent value="ci" className="pt-4 space-y-4">
          <PipelineEditor ns={ns} repo={repo} pipelines={pipelines} onChange={loadAll} />
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

function PipelineEditor({ ns, repo, pipelines, onChange }: { ns: string; repo: string; pipelines: CiPipeline[]; onChange: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [yaml, setYaml] = useState("name: tests\non: [change]\nsteps:\n  - run: npm test\n");
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setError(null);
    try { await api.upsertPipeline(ns, repo, name || "default", yaml, true); await onChange(); setName(""); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <div className="space-y-3">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="grid grid-cols-[1fr_2fr] gap-3">
        <Input placeholder="Pipeline name (e.g. tests)" value={name} onChange={e => setName(e.target.value)} />
        <Button onClick={save} disabled={!yaml}>Save pipeline</Button>
      </div>
      <Textarea className="font-mono text-xs" rows={10} value={yaml} onChange={e => setYaml(e.target.value)} />
      <div className="space-y-2">
        {pipelines.length === 0 ? <div className="text-sm text-muted-foreground">No pipelines configured.</div>
          : pipelines.map(p => (
            <div key={p.id} className="p-3 rounded border bg-card">
              <code className="font-mono text-sm text-primary">{p.name}</code>
              <pre className="text-xs font-mono mt-1 text-muted-foreground whitespace-pre-wrap">{p.yaml}</pre>
            </div>
          ))}
      </div>
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
            <p className="text-sm">Secret (save this — it won&apos;t be shown again):</p>
            <code className="block p-2 bg-muted rounded font-mono text-xs break-all">{secret}</code>
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
