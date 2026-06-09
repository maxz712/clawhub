"use client";

import { useEffect, useState, use } from "react";
import { api, type Issue, type IssueStatus } from "@/lib/api";
import { IssueRow } from "@/components/issue-row";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Plus } from "lucide-react";

export default function IssuesPage({ params }: { params: Promise<{ ns: string; repo: string }> }) {
  const { ns, repo } = use(params);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [status, setStatus] = useState<IssueStatus>("open");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);

  async function load() {
    const r = await api.listIssues(ns, repo, { status });
    setIssues(r.issues);
  }
  useEffect(() => { load().catch(e => setError((e as Error).message)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ns, repo, status]);

  async function create() {
    if (!title) return;
    setPending(true);
    try {
      await api.createIssue(ns, repo, { title, body: body || undefined });
      setTitle(""); setBody(""); setOpen(false);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Issues · <code className="font-mono">{ns}/{repo}</code></h1>
        <Button size="sm" className="gap-2" onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New issue</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader><DialogTitle>New issue</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Title</Label><Input value={title} onChange={e => setTitle(e.target.value)} autoFocus /></div>
              <div><Label>Body</Label><Textarea value={body} onChange={e => setBody(e.target.value)} rows={5} /></div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={pending || !title}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex gap-2">
        {(["open", "closed"] as IssueStatus[]).map(s => (
          <button key={s} onClick={() => setStatus(s)} className={`text-xs font-mono px-3 py-1 rounded border ${status === s ? "bg-primary/10 border-primary/40 text-primary" : "text-muted-foreground border-border hover:text-foreground"}`}>{s}</button>
        ))}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!issues ? <div className="text-muted-foreground">Loading…</div>
        : issues.length === 0 ? <div className="p-6 text-center rounded border bg-card text-muted-foreground">No {status} issues.</div>
        : <ul className="space-y-2">{issues.map(i => <IssueRow key={i.id} issue={i} href={`/repos/${ns}/${repo}/issues/${i.number}`} />)}</ul>}
    </div>
  );
}
