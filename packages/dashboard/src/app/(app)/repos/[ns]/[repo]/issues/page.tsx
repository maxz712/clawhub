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
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("");
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
      const labelList = labels.split(",").map(s => s.trim()).filter(Boolean);
      await api.createIssue(ns, repo, { title, body: body || undefined, labels: labelList.length ? labelList : undefined });
      setTitle(""); setBody(""); setLabels(""); setOpen(false);
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  }

  // Distinct labels across the loaded issue set (no label-list endpoint), for a
  // client-side label filter.
  const allLabels = Array.from(new Set((issues ?? []).flatMap(i => i.labels))).sort();
  const visibleIssues = (issues ?? []).filter(i => !labelFilter || i.labels.includes(labelFilter));

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
              <div><Label>Labels (comma-separated)</Label><Input value={labels} onChange={e => setLabels(e.target.value)} placeholder="bug, p1" /></div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={pending || !title}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["open", "closed"] as IssueStatus[]).map(s => (
          <button key={s} onClick={() => setStatus(s)} className={`text-xs font-mono px-3 py-1 rounded border ${status === s ? "bg-primary/10 border-primary/40 text-primary" : "text-muted-foreground border-border hover:text-foreground"}`}>{s}</button>
        ))}
        {allLabels.length > 0 && (
          <>
            <span className="text-border">·</span>
            <button onClick={() => setLabelFilter(null)} className={`text-xs px-3 py-1 rounded border ${labelFilter === null ? "bg-primary/10 border-primary/40 text-primary" : "text-muted-foreground border-border hover:text-foreground"}`}>all labels</button>
            {allLabels.map(l => (
              <button key={l} onClick={() => setLabelFilter(labelFilter === l ? null : l)} className={`text-xs px-3 py-1 rounded border ${labelFilter === l ? "bg-primary/10 border-primary/40 text-primary" : "text-muted-foreground border-border hover:text-foreground"}`}>{l}</button>
            ))}
          </>
        )}
      </div>

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {!issues ? <div className="text-muted-foreground">Loading…</div>
        : visibleIssues.length === 0 ? <div className="p-6 text-center rounded border bg-card text-muted-foreground">No {status} issues{labelFilter ? ` labeled "${labelFilter}"` : ""}.</div>
        : <ul className="space-y-2">{visibleIssues.map(i => <IssueRow key={i.id} issue={i} href={`/repos/${ns}/${repo}/issues/${i.number}`} />)}</ul>}
    </div>
  );
}
